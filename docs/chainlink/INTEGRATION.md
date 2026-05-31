# AltPay — Integração Chainlink & CRE (detalhe completo)

Este documento descreve **exatamente** onde e como cada produto Chainlink é usado no
AltPay, com arquivos, linhas, endereços e estado real (o que roda on-chain vs. o que é
simulado vs. o que é roadmap). Decisão de arquitetura: `.sdd/uber-money-v2/decisions/DR-004-chainlink-onchain-refactor.md`.

> **Resumo honesto em uma linha:** usamos **2 produtos Chainlink** — **Data Feeds (Solana)**
> de verdade on-chain via CPI (circuit breaker SOL/USD) e **CRE** como workflow de score
> TS→WASM validado por `simulate` no sandbox DON. **CCIP não é usado** (roadmap v2).

---

## 1. Visão geral — onde cada peça vive

| Peça | Produto | Estado | Onde |
|---|---|---|---|
| Circuit breaker SOL/USD | **Chainlink Data Feeds (Solana)** | ✅ **CPI on-chain real** em devnet | `programs/uber-money/src/lib.rs` |
| Score de crédito (workflow) | **Chainlink CRE** (TS→WASM) | ✅ compila + `simulate` funcional / ⛔ **não plugado no fluxo live** | `cre/score-workflow/` |
| Attestation do oráculo | Ed25519 (ponte, não é produto Chainlink) | ✅ on-chain via sysvar + anti-forja | `_shared/ed25519-attest.ts` + `lib.rs` |
| CCIP cross-chain | Chainlink CCIP | 📋 roadmap v2 (sem EVM no MVP) | — |

---

## 2. Chainlink Data Feeds (Solana) — REAL, on-chain via CPI

### 2.1 Para que serve
**Circuit breaker de mercado.** Antes de liberar USDC do vault pro motorista, o programa
Anchor lê o preço **SOL/USD** do feed Chainlink on-chain. Se o preço estiver abaixo de um
piso (`SOL_CRASH_MIN`), o empréstimo é **abortado** (`MarketCrashHalt`). Objetivo: não
desembolsar durante um crash de mercado. Não é decoração — a leitura é CPI real e o
`require!` reverte a tx.

### 2.2 Endereços (devnet)
| Item | Endereço |
|---|---|
| **Store program** (alvo do CPI) | `HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny` |
| **SOL/USD feed** (devnet) | `HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6` |

⚠️ Não confundir o Store program com o OCR program (`cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ`).

### 2.3 Crate
`programs/uber-money/Cargo.toml:22` → `chainlink_solana = "1.0.0"`

### 2.4 Constantes (pin de segurança)
`programs/uber-money/src/lib.rs`:
- `SOL_USD_FEED_DEVNET` (L22) — feed pinado por endereço.
- `CHAINLINK_PROGRAM_ID` (L26) — Store program pinado. **Sem o pin**, um atacante passaria
  um programa falso que devolve `answer` alto e burlaria o breaker.
- `SOL_CRASH_MIN = 10_00000000` (L29) — piso de **$10** (8 casas decimais).
  O feed devnet é **stale** (~$22, snapshot mar/2023) porque a Chainlink não atualiza
  testnet com frequência; o piso $10 garante happy-path sem false-halt na demo.

### 2.5 Leitura on-chain (em `borrower_request_loan`)
`programs/uber-money/src/lib.rs:83-94`:
```rust
let feed = &ctx.accounts.chainlink_feed;
let chainlink_program = &ctx.accounts.chainlink_program;
require!(*feed.key == SOL_USD_FEED_DEVNET, UberError::WrongFeed);   // pin do feed
let round = chainlink_solana::latest_round_data(
    chainlink_program.to_account_info(),
    feed.to_account_info(),
).map_err(|_| UberError::FeedReadFailed)?;
let answer: i128 = round.answer;
require!(answer >= SOL_CRASH_MIN, UberError::MarketCrashHalt);       // circuit breaker
```
O valor lido é persistido no estado do empréstimo: `loan.usdc_feed_answer = answer` (L107)
e emitido no evento `LoanReleasedOnChain` (L134).

> **Nota de nomenclatura honesta:** o campo se chama `usdc_feed_answer` (Loan/evento,
> lib.rs:526/553) por herança do design original (USDC/USD), mas **armazena a resposta do
> feed SOL/USD**. USDC/USD **não existe em devnet** (mai/2026), então usamos SOL/USD com o
> threshold ajustado. Renomear o campo exige migração do account layout — adiado.

### 2.6 Accounts exigidas (struct Anchor)
`programs/uber-money/src/lib.rs:425-429`:
```rust
/// CHECK: Chainlink Data Feed account (validado por endereço hardcoded)
pub chainlink_feed: AccountInfo<'info>,
/// CHECK: chainlink_solana program (pin por endereço)
pub chainlink_program: AccountInfo<'info>,
```

### 2.7 Como o frontend passa esses accounts
`src/lib/solana-tx-builder.ts`:
- L32 `CHAINLINK_PROGRAM = HEvSKof…`
- L33 `SOL_USD_FEED_DEVNET = HgTtcb…`
- L148-149 — incluídos como keys (read-only) na ix `borrower_request_loan`.

### 2.8 Erros relacionados
`programs/uber-money/src/lib.rs:594-599`:
`WrongFeed` (feed errado), `FeedReadFailed` (CPI falhou), `MarketCrashHalt` (preço < piso).

### 2.9 Evidência on-chain
tx devnet com o programa fazendo `invoke` do Store program `HEvSKof…`:
`2Uu56mExht7tRoaxdy2W41eAx3z9kByJfrF8LiErKDUeRGpZT7G8yWVdGkQaDQ33H3e7mH3R4CxVkMtzNGQ7yWF2`
(explorer cluster=devnet).

---

## 3. Chainlink CRE — workflow de score (TS→WASM)

### 3.1 Para que serve (e o que NÃO faz)
O CRE workflow recebe `{ wallet, monthlyIncomeBRL, requestedAmountBRL }` por HTTP trigger e
devolve uma **decisão de crédito** (`approved`, `score`, `limitBRL`, `interestPctMonthly`,
`reason`). Prova que a lógica de score roda num runtime DON.

⛔ **Não está plugado no fluxo de produção.** O score que o app realmente usa roda na edge
function `score-credit` via `_shared/score-rules.ts` → `computeScoreV5` (lógica diferente e
mais rica: finalidade, fonte de renda, status do veículo, negativação). O CRE é um
**artefato paralelo** validado por `simulate`, não o caminho crítico do empréstimo.

### 3.2 Arquivos
- `cre/score-workflow/main.ts` — workflow. `computeScore()` (L37) + `onHTTPTrigger` (L78)
  + `initWorkflow`/`main` (L105-115). Usa `@chainlink/cre-sdk` + `zod` pra validar input.
- `cre/score-workflow/workflow.yaml` — settings `staging-settings` / `production-settings`
  (workflow-name, path do `main.ts`, config por ambiente).
- `cre/score-workflow/config.staging.json` / `config.production.json` — config validada por
  `configSchema` (zod): `scoreApiBase`, `chainSelectorName` (`ethereum-testnet-sepolia`),
  `minIncomeBRL: 1500`, `scoreThreshold: 600`, `maxLoanUsdcMicro: "10000000"`.
- `cre/score-workflow/payload.json` — payload de exemplo do trigger HTTP.
- `cre/README.md` — setup (CLI `cre`, `bun`), build e simulate.

### 3.3 Lógica de score (`computeScore`, main.ts:37-76)
- `MONTHS_RANGE=6`, `MAX_RATIO=0.30`, juros `BASE=2.9%`..`MAX=4.9%`/mês.
- Renda < `minIncomeBRL` → rejeita (`income_below_minimum`).
- `limitBRL = renda * 6 * 0.30`; `score = min(1000, floor(renda/10))`.
- Aprova se `score >= scoreThreshold` **e** `requested <= limitBRL`.
- Juros interpolados pelo score.

### 3.4 Build & simulate
```bash
cd cre/score-workflow && bun install
cd cre && cre workflow build ./score-workflow          # → binary.wasm + hash
cre workflow simulate ./score-workflow \
  --http-payload '{"wallet":"abc","monthlyIncomeBRL":4250,"requestedAmountBRL":5}'
```
Login OAuth do `cre` na VPS exige SSH tunnel da porta de callback (`ssh -L 53682:...`).
Deploy em DON real exige **Early Access** aprovado (só `simulate` é grátis).

### 3.5 Evidência de simulate
`docs/chainlink/cre-simulate-evidence.txt` — run de 2026-05-28T17:26:47Z:
- Binary hash `291d8a4b…`, Config hash `4cddf851…`.
- Input income=R$6500, requested=R$1 → **APPROVED**, score=650, limitBRL=11700, juros=3.6%.

---

## 4. Ponte Ed25519 (oráculo off-chain → contrato)

Não é produto Chainlink, mas é o que conecta a decisão de score ao desembolso on-chain.

- **Oráculo (edge):** `supabase/functions/_shared/ed25519-attest.ts` — a keypair admin assina
  um payload (`cpf_hash`, `amount`, `score`, `expires_at`, **borrower pubkey**). Assinar a
  pubkey do borrower impede que uma attestation vazada seja resgatada por outra carteira.
- **Frontend:** anexa um `Ed25519Program.createInstructionWithPublicKey(...)` ANTES da ix do
  programa (`src/lib/solana-tx-builder.ts:112`).
- **Programa Anchor:** valida via instructions sysvar — varre as ixs, acha a do
  `Ed25519SigVerify…` e confere pubkey/mensagem (`lib.rs:59-81`,
  `verify_ed25519_attestation`). **Anti-forja:** rejeita `instruction_index == 0xFFFF`
  (prova: `scripts/smoke-repay-forgery.ts` → erro 6013).

---

## 5. CCIP — NÃO usado (roadmap v2)

Escopo do MVP é **Solana-only**. CCIP→Solana foi descartado por exigir EVM/Sepolia. O
desembolso é o motorista chamando `borrower_request_loan` direto (Phantom signer), não um
`ccip_receive`. **Upgrade path:** trocar a attestation Ed25519 por `ccip_receive` real
(assinatura compatível) via solana-starter-kit.

---

## 6. Fluxo end-to-end (1 tx, 3 instructions)

```
Motorista (Phantom) assina 1 tx:
  ix[0] Ed25519Program        → verifica attestation do oráculo (score assinado)
  ix[1] ATA idempotent        → cria conta USDC do motorista se faltar
  ix[2] borrower_request_loan → Anchor:
          • valida Ed25519 via sysvar instructions (anti-forja 0xFFFF)
          • CPI → Chainlink Data Feed SOL/USD (Store HEvSKof…)
          • circuit breaker: require!(answer >= $10) senão MarketCrashHalt
          • transfere USDC vault → motorista
```
