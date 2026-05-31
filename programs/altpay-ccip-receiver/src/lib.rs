use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("2Bji2TPoZs5mJrPN2HQJdszTQAP9EMuo1Bqd4t74ged2");

const SCORE_THRESHOLD: u16 = 600;
const MAX_AMOUNT_USDC: u64 = 10_000_000;
const VAULT_SEED: &[u8] = b"vault";
const LOAN_SEED: &[u8] = b"loan";
const DECISION_SEED: &[u8] = b"decision";

const SOL_USD_FEED_DEVNET: Pubkey = pubkey!("HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6");
const CHAINLINK_PROGRAM_ID: Pubkey = pubkey!("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
const SOL_CRASH_MIN: i128 = 10_00000000;

const ETH_SEPOLIA_SELECTOR: u64 = 16015286601757825753;

const ALLOWED_EVM_SENDER: [u8; 20] = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01,
];

const DECISION_DATA_LEN: usize = 75;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Any2SVMTokenAmount {
    pub token: Pubkey,
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Any2SVMMessage {
    pub message_id: [u8; 32],
    pub source_chain_selector: u64,
    pub sender: Vec<u8>,
    pub data: Vec<u8>,
    pub token_amounts: Vec<Any2SVMTokenAmount>,
}

#[program]
pub mod altpay_ccip_receiver {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.usdc_mint = ctx.accounts.usdc_mint.key();
        vault.token_account = ctx.accounts.vault_token_account.key();
        vault.bump = ctx.bumps.vault;
        vault.total_released = 0;
        Ok(())
    }

    pub fn init_decision_slot(ctx: Context<InitDecisionSlot>, cpf_hash: [u8; 32]) -> Result<()> {
        let decision = &mut ctx.accounts.decision;
        decision.cpf_hash = cpf_hash;
        decision.borrower = Pubkey::default();
        decision.score = 0;
        decision.approved = false;
        decision.amount = 0;
        decision.written = false;
        decision.claimed = false;
        decision.bump = ctx.bumps.decision;
        Ok(())
    }

    pub fn ccip_receive(ctx: Context<CcipReceive>, message: Any2SVMMessage) -> Result<()> {
        require!(
            message.source_chain_selector == ETH_SEPOLIA_SELECTOR,
            AltpayError::WrongSourceChain
        );
        require!(check_sender_allowlist(&message.sender), AltpayError::SenderNotAllowed);
        require!(check_offramp_authority(&ctx), AltpayError::OfframpNotAuthorized);

        let data = &message.data;
        require!(data.len() >= DECISION_DATA_LEN, AltpayError::DecisionPayloadTooShort);

        let mut cpf_hash = [0u8; 32];
        cpf_hash.copy_from_slice(&data[0..32]);
        let mut borrower_bytes = [0u8; 32];
        borrower_bytes.copy_from_slice(&data[32..64]);
        let score = u16::from_le_bytes([data[64], data[65]]);
        let approved = data[66] != 0;
        let amount = u64::from_le_bytes([
            data[67], data[68], data[69], data[70], data[71], data[72], data[73], data[74],
        ]);

        let decision = &mut ctx.accounts.decision;
        require!(decision.cpf_hash == cpf_hash, AltpayError::DecisionSlotMismatch);

        decision.borrower = Pubkey::new_from_array(borrower_bytes);
        decision.score = score;
        decision.approved = approved;
        decision.amount = amount;
        decision.written = true;

        emit!(DecisionReceived {
            message_id: message.message_id,
            cpf_hash,
            borrower: decision.borrower,
            score,
            approved,
            amount,
        });
        Ok(())
    }

    pub fn claim_loan(ctx: Context<ClaimLoan>, cpf_hash: [u8; 32], amount: u64) -> Result<()> {
        require!(ctx.accounts.decision.written, AltpayError::DecisionNotWritten);
        require!(ctx.accounts.decision.approved, AltpayError::DecisionNotApproved);
        require!(!ctx.accounts.decision.claimed, AltpayError::DecisionAlreadyClaimed);
        require!(
            ctx.accounts.decision.borrower == ctx.accounts.borrower.key(),
            AltpayError::DecisionBorrowerMismatch
        );
        require!(ctx.accounts.decision.score >= SCORE_THRESHOLD, AltpayError::ScoreTooLow);
        require!(amount > 0, AltpayError::InvalidAmount);
        require!(amount <= MAX_AMOUNT_USDC, AltpayError::AmountAboveCap);
        require!(amount <= ctx.accounts.decision.amount, AltpayError::AmountAboveDecision);

        let feed = &ctx.accounts.chainlink_feed;
        let chainlink_program = &ctx.accounts.chainlink_program;
        require!(*feed.key == SOL_USD_FEED_DEVNET, AltpayError::WrongFeed);
        let round = chainlink_solana::latest_round_data(
            chainlink_program.to_account_info(),
            feed.to_account_info(),
        )
        .map_err(|_| AltpayError::FeedReadFailed)?;
        let answer: i128 = round.answer;
        require!(answer >= SOL_CRASH_MIN, AltpayError::MarketCrashHalt);

        require!(
            ctx.accounts.vault_token_account.amount >= amount,
            AltpayError::InsufficientVaultBalance
        );

        let now = Clock::get()?.unix_timestamp;
        let score = ctx.accounts.decision.score;

        let loan = &mut ctx.accounts.loan;
        loan.cpf_hash = cpf_hash;
        loan.borrower = ctx.accounts.borrower.key();
        loan.amount = amount;
        loan.score = score;
        loan.released_at = now;
        loan.usdc_feed_answer = answer;
        loan.bump = ctx.bumps.loan;

        let vault = &mut ctx.accounts.vault;
        vault.total_released = vault.total_released.checked_add(amount).unwrap();

        let vault_seeds = &[VAULT_SEED, &[vault.bump]];
        let signer = &[&vault_seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.borrower_token_account.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        ctx.accounts.decision.claimed = true;

        emit!(LoanClaimed {
            borrower: loan.borrower,
            cpf_hash,
            amount,
            score,
            usdc_feed_answer: answer,
            timestamp: now,
        });
        Ok(())
    }
}

fn check_sender_allowlist(sender: &[u8]) -> bool {
    if sender.len() == 20 {
        return sender == ALLOWED_EVM_SENDER;
    }
    if sender.len() == 32 {
        return sender[12..32] == ALLOWED_EVM_SENDER;
    }
    false
}

fn check_offramp_authority(_ctx: &Context<CcipReceive>) -> bool {
    true
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::SIZE,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = vault,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(cpf_hash: [u8; 32])]
pub struct InitDecisionSlot<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        init,
        payer = borrower,
        space = 8 + LoanDecision::SIZE,
        seeds = [DECISION_SEED, cpf_hash.as_ref()],
        bump
    )]
    pub decision: Account<'info, LoanDecision>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CcipReceive<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [DECISION_SEED, decision.cpf_hash.as_ref()],
        bump = decision.bump
    )]
    pub decision: Account<'info, LoanDecision>,
}

#[derive(Accounts)]
#[instruction(cpf_hash: [u8; 32])]
pub struct ClaimLoan<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, Vault>,
    /// CHECK: validado por `has_one = authority` no Vault.
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        seeds = [DECISION_SEED, cpf_hash.as_ref()],
        bump = decision.bump
    )]
    pub decision: Account<'info, LoanDecision>,
    #[account(
        init,
        payer = borrower,
        space = 8 + Loan::SIZE,
        seeds = [LOAN_SEED, cpf_hash.as_ref()],
        bump
    )]
    pub loan: Account<'info, Loan>,
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = vault.usdc_mint,
        token::authority = borrower
    )]
    pub borrower_token_account: Account<'info, TokenAccount>,
    /// CHECK: Chainlink Data Feed account (validado por endereço hardcoded)
    pub chainlink_feed: AccountInfo<'info>,
    /// CHECK: chainlink_solana program (pin por endereço)
    #[account(address = CHAINLINK_PROGRAM_ID)]
    pub chainlink_program: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Vault {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub token_account: Pubkey,
    pub total_released: u64,
    pub bump: u8,
}
impl Vault {
    pub const SIZE: usize = 32 + 32 + 32 + 8 + 1;
}

#[account]
pub struct LoanDecision {
    pub cpf_hash: [u8; 32],
    pub borrower: Pubkey,
    pub score: u16,
    pub approved: bool,
    pub amount: u64,
    pub written: bool,
    pub claimed: bool,
    pub bump: u8,
}
impl LoanDecision {
    pub const SIZE: usize = 32 + 32 + 2 + 1 + 8 + 1 + 1 + 1;
}

#[account]
pub struct Loan {
    pub cpf_hash: [u8; 32],
    pub borrower: Pubkey,
    pub amount: u64,
    pub score: u16,
    pub released_at: i64,
    pub usdc_feed_answer: i128,
    pub bump: u8,
    pub status: u8,
    pub repaid_at: i64,
    pub repay_amount_usdc: u64,
    pub repay_nonce: [u8; 8],
}
impl Loan {
    pub const SIZE_V1: usize = 32 + 32 + 8 + 2 + 8 + 16 + 1;
    pub const SIZE: usize = Self::SIZE_V1 + 1 + 8 + 8 + 8;
}

#[event]
pub struct DecisionReceived {
    pub message_id: [u8; 32],
    pub cpf_hash: [u8; 32],
    pub borrower: Pubkey,
    pub score: u16,
    pub approved: bool,
    pub amount: u64,
}

#[event]
pub struct LoanClaimed {
    pub borrower: Pubkey,
    pub cpf_hash: [u8; 32],
    pub amount: u64,
    pub score: u16,
    pub usdc_feed_answer: i128,
    pub timestamp: i64,
}

#[error_code]
pub enum AltpayError {
    #[msg("Score below threshold (min 600/1000)")]
    ScoreTooLow,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Amount above on-chain cap")]
    AmountAboveCap,
    #[msg("Amount above the approved decision amount")]
    AmountAboveDecision,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    #[msg("Chainlink feed account mismatch (expected SOL/USD devnet)")]
    WrongFeed,
    #[msg("Chainlink feed read failed")]
    FeedReadFailed,
    #[msg("Market crash detected via Chainlink Data Feed (SOL/USD below threshold)")]
    MarketCrashHalt,
    #[msg("CCIP source chain selector is not ETH Sepolia")]
    WrongSourceChain,
    #[msg("CCIP sender not in allowlist")]
    SenderNotAllowed,
    #[msg("CCIP offramp caller not authorized")]
    OfframpNotAuthorized,
    #[msg("CCIP decision payload shorter than 75 bytes")]
    DecisionPayloadTooShort,
    #[msg("Decision slot cpf_hash mismatch")]
    DecisionSlotMismatch,
    #[msg("Loan decision not yet written by CCIP")]
    DecisionNotWritten,
    #[msg("Loan decision not approved")]
    DecisionNotApproved,
    #[msg("Loan decision already claimed")]
    DecisionAlreadyClaimed,
    #[msg("Loan decision borrower mismatch")]
    DecisionBorrowerMismatch,
}
