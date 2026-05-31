# AltPay 💸

**Microcrédito on-chain instantâneo para motoristas de aplicativo.**

Pede no app → score on-chain via Chainlink CRE aprova → **Pix cai na conta em segundos**. Construído para o **Hackanation 2026** (TokenNation · Solana + Chainlink · tese RWA).

🔗 **Live (devnet):** https://ubermoney.devfellowship.com — conecta com Phantom em devnet.

## Pitch
> Furou o pneu? Acabou a gasolina? O dinheiro cai no seu Pix em segundos. Score on-chain, juros baixos, sem consulta ao SPC.

## Datas
- **Submit inicial:** 30/05/2026 (Taikai)
- **Submit final:** 01/06/2026 noite
- **Pitch presencial:** 02/06/2026, Pavilhão da Bienal SP

## Stack
| Camada | Tech |
|---|---|
| Front | Vite + React 19 + TS + Tailwind v4 + framer-motion |
| Wallet | `@solana/wallet-adapter` (Phantom only — v9 Q24) |
| Backend | Supabase (Postgres + Edge Functions Deno + JWT) |
| On-chain | Anchor 0.30 — `borrower_request_loan` (motorista assina) + Ed25519 attestation + Chainlink Data Feed |
| Oráculo | **Chainlink CRE** workflow (TS→WASM, simulate via sandbox) + **Chainlink Data Feeds** SOL/USD on-chain circuit breaker |
| Pix | Woovi (env `WOOVI_MODE=prod\|mock`) |
| Stablecoin | USDC devnet |
| RPC | Helius devnet + QuickNode failover (v9 Q25) |
| Hosting | Vercel |

## Chainlink integration (DR-004)

> 📄 **Detalhe completo (arquivos, linhas, endereços, estado real):** [`docs/chainlink/INTEGRATION.md`](docs/chainlink/INTEGRATION.md)

100% on-chain Solana. Dois produtos Chainlink reais num único programa Anchor.

```
Motorista (Phantom)
   ↓ assina 1 tx contendo 3 instructions:
   ┌────────────────────────────────────────────┐
   │ ix[0] Ed25519Program — verifica attestation│
   │       do oracle (CRE workflow score)       │
   │ ix[1] ATA idempotent (USDC do motorista)   │
   │ ix[2] borrower_request_loan (Anchor):      │
   │   • valida Ed25519 via sysvar instructions │
   │   • CPI → Chainlink Data Feed (SOL/USD)    │
   │   • circuit breaker: halt se SOL < $10     │
   │   • transfere USDC vault → motorista       │
   └────────────────────────────────────────────┘
```

| Produto Chainlink | Estado | Evidência |
|---|---|---|
| **CRE workflow** TS→WASM | ✅ compila + **simulate funcional** | `docs/chainlink/cre-simulate-evidence.txt` (score=650, approved) |
| **Data Feeds Solana** (SOL/USD) | ✅ **CPI on-chain real** | tx [2Uu56mExh...yWF2](https://explorer.solana.com/tx/2Uu56mExht7tRoaxdy2W41eAx3z9kByJfrF8LiErKDUeRGpZT7G8yWVdGkQaDQ33H3e7mH3R4CxVkMtzNGQ7yWF2?cluster=devnet) (programa invoke `HEvSKof…`) |
| Ed25519 oracle attestation | ✅ on-chain via sysvar + **anti-forja** (`instruction_index == 0xFFFF`) | prova on-chain: `scripts/smoke-repay-forgery.ts` (erro 6013 `InvalidRepayAttestationLayout`) |
| CCIP cross-chain | 📋 roadmap v2 (sem EVM no MVP) | DR-004 |
| CRE deploy + verify Sepolia | ⏳ 28/05 | Etherscan link aqui (TODO) |
| CCIP `ccipSend` Sepolia | ⏳ 28/05 | `messageId` em [ccip.chain.link](https://ccip.chain.link) (TODO) |
| Solana receiver (CCIP) | 📋 fora do MVP — Solana-only, sem hop CCIP. Desembolso = motorista chama `borrower_request_loan` direto (Phantom signer). CCIP cross-chain é roadmap v2. | DR-004 |

**Pivot 28/05 (DR-004):** Saímos do MOCK CCIP e fomos pra **Chainlink real on-chain Solana**:
- CRE workflow simulate funcional (Chainlink sandbox DON)
- Data Feeds SOL/USD lido on-chain via CPI (Store program `HEvSKof…`)
- Motorista assina direto (Phantom signer)
- Ed25519 attestation pre-instruction
- Circuit breaker propositado (não decoração teatral)

**Por que `borrower_request_loan` em vez de um receiver CCIP:** narrativa "microcrédito on-chain Solana" exige motorista chamando contrato direto. CCIP→Solana descartado por requerer EVM/Sepolia (incompatível com escopo Solana-only).

**Upgrade path produção:** trocar Ed25519 attestation por CCIP `ccip_receive` real via [solana-starter-kit](https://github.com/smartcontractkit/solana-starter-kit). Assinatura compatível.

## Programa Anchor — LIVE em devnet ✅

| Item | Endereço/Tx | Explorer |
|---|---|---|
| **Program ID** | `6m2ipcrUCRpSqkPSqNNKNH11rNmVsu8KmnBLnBtFsq2N` | [open](https://explorer.solana.com/address/6m2ipcrUCRpSqkPSqNNKNH11rNmVsu8KmnBLnBtFsq2N?cluster=devnet) |
| **Deploy tx** | `SXGHAapoVN8eyXqGvFJR94A3a8Vu6AHrmbSwBjjsZSrPD1XLoF8gWsLzWZyEsWAEEuKJ48beDazaMezCn88jyPK` | [open](https://explorer.solana.com/tx/SXGHAapoVN8eyXqGvFJR94A3a8Vu6AHrmbSwBjjsZSrPD1XLoF8gWsLzWZyEsWAEEuKJ48beDazaMezCn88jyPK?cluster=devnet) |
| **Authority (admin)** | `5y4M6HGghXAj5TYupFncUWXMEN7LKjDMDvMLiPsodUCa` | [open](https://explorer.solana.com/address/5y4M6HGghXAj5TYupFncUWXMEN7LKjDMDvMLiPsodUCa?cluster=devnet) |
| **Vault PDA** | `AE5KWqjhDGNRvk4bV4nEJGbcSy15eAWVVazHyPsjbnxz` | [open](https://explorer.solana.com/address/AE5KWqjhDGNRvk4bV4nEJGbcSy15eAWVVazHyPsjbnxz?cluster=devnet) |
| **Vault Token Account** | `2U6Tqapn6KVc5X9AfiMgCninXAk8L3tGgVwcKghvp3ST` | [open](https://explorer.solana.com/address/2U6Tqapn6KVc5X9AfiMgCninXAk8L3tGgVwcKghvp3ST?cluster=devnet) |
| **init_vault tx** | `u4rBqTRwQpTcmqeUEHfxZ92zMahYY3nFboQeLLTE8GnYqL8izP3QmsVrhfksdT9dFbnvitDiSpzQW4jmLd9rhzP` | [open](https://explorer.solana.com/tx/u4rBqTRwQpTcmqeUEHfxZ92zMahYY3nFboQeLLTE8GnYqL8izP3QmsVrhfksdT9dFbnvitDiSpzQW4jmLd9rhzP?cluster=devnet) |
| **Smoke release_loan tx** | `2TyJskPWqYyBpYevdN5iBDEoZ1GjZ5yKyKW29spaS2aEhh8mhXqmSgK4Rrfqjkvk7p3XjFJV1MDkGVxksxiHvB9j` | [open](https://explorer.solana.com/tx/2TyJskPWqYyBpYevdN5iBDEoZ1GjZ5yKyKW29spaS2aEhh8mhXqmSgK4Rrfqjkvk7p3XjFJV1MDkGVxksxiHvB9j?cluster=devnet) |
| **USDC mint devnet (Circle)** | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | [open](https://explorer.solana.com/address/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet) |

**Vault pre-funded com 20 USDC oficial Circle.** Smokes confirmados on-chain:
- 27/05: `release_loan` admin-signed via [tx 2TyJsk…vB9j](https://explorer.solana.com/tx/2TyJskPWqYyBpYevdN5iBDEoZ1GjZ5yKyKW29spaS2aEhh8mhXqmSgK4Rrfqjkvk7p3XjFJV1MDkGVxksxiHvB9j?cluster=devnet) (legacy)
- 28/05: `borrower_request_loan` motorista-signed + Ed25519 + Chainlink Data Feed via [tx 2Uu56mEx…yWF2](https://explorer.solana.com/tx/2Uu56mExht7tRoaxdy2W41eAx3z9kByJfrF8LiErKDUeRGpZT7G8yWVdGkQaDQ33H3e7mH3R4CxVkMtzNGQ7yWF2?cluster=devnet) (DR-004 F+)

Instructions:
- `initialize_vault()` — one-shot, cria vault PDA `[b"vault"]` + token account
- **`borrower_request_loan(cpf_hash, amount, score, expires_at)`** — DR-004 F+ atual: motorista é Signer, valida Ed25519 attestation + CPI Chainlink Data Feed, transfere USDC
- `release_loan(cpf_hash, amount, score)` — admin-signed legacy fallback (`has_one = authority`, sem attestation), usado só com `VITE_ONCHAIN_FLOW=false`
- `repay_loan(cpf_hash, amount, nonce, expires_at)` — motorista assina + Ed25519 `REPAY_V1`, marca PDA Repaid
- `cash_out(cpf_hash, amount)` — motorista assina swap-back USDC→vault (anti double-spend antes do Pix)

PDA seed: `[b"loan", sha256(cpf || users.cpf_pepper)]` — 1 empréstimo por CPF lifetime. `init` (não `init_if_needed`) → falha hard se já existe.

Build:
```bash
cd programs/uber-money
cargo update -p crypto-common@0.2.2 --precise 0.1.6
cargo update -p blake3 --precise 1.5.5
cargo update -p jobserver --precise 0.1.32
cargo update -p proc-macro-crate@3.5.0 --precise 3.2.0
cargo update -p indexmap@2.14.0 --precise 2.6.0
cargo update -p proc-macro2 --precise 1.0.94
cd ../..
anchor build  # IDL falha (proc-macro2/nightly), mas .so compila
```

Deploy:
```bash
solana airdrop 2  # ou faucet.solana.com
solana program deploy target/deploy/uber_money.so \
  --program-id target/deploy/uber_money-keypair.json
```

## Como rodar (front)
```bash
pnpm install
pnpm dev
```
Abre em `http://localhost:5173`. Conecta com Phantom em **devnet**.

## Runbook de demo (dia do pitch)

Landmines que quebram o fluxo ao vivo — checar ANTES de subir no palco:

1. **CPF fresco por demo.** PDA do loan é `[b"loan", sha256(cpf||pepper)]` com `init` (não `init_if_needed`) → **1 empréstimo por CPF lifetime**. Repetir o mesmo CPF dá `account already in use` (0x0). Use uma CNH/CPF novos a cada demo, OU rode `dev-reset` (local) pra limpar o estado do user. O CPF vem do OCR da CNH — troque a imagem.
2. **Phantom precisa de SOL devnet.** O motorista assina e paga fee. Pré-funde a wallet: `solana airdrop 2 <PHANTOM_PUBKEY> --url devnet` (ou faucet.solana.com). Sem SOL → tx falha na assinatura.
3. **RPC = Helius.** Setar `VITE_HELIUS_RPC_URL` (devnet) — o RPC público da Solana derruba por rate-limit no meio da demo. `VITE_QUICKNODE_RPC_URL` é failover (ver `WalletProvider.tsx`).
4. **Vault tem USDC?** Saldo vivo cai a cada smoke (hoje ~8.8 USDC). Com cap `PAYOUT_MAX_BRL=10` cada loan saca pouco, mas confira o vault token account `2U6Tqapn…p3ST` antes. Re-funde via faucet.circle.com se baixo.
5. **Feed Chainlink devnet é stale (~$22).** O circuit breaker `SOL < $10` fica sempre verde — isso é esperado e honesto (o valor é provar a CPI real, não halt de mercado). Não tente forçar halt ao vivo.
6. **WOOVI_MODE.** Em `mock` o Pix auto-confirma em ~8s (sem rede). Para demo sem internet confiável, mantenha `mock`. Pix real só em `prod` (ver §4.1 do DEPLOY.md).

## Estrutura
```
/                       # Front Vite+React (web app)
  src/
    pages/              # 6 telas: login, upload, request, analysis, approved, home
    components/         # atoms / molecules / organisms (atomic design)
    lib/
      api.ts            # cliente Supabase Edge Functions (releaseLoan + requestPayout)
programs/uber-money/    # Programa Anchor (Rust/Solana)
cre/score-workflow/     # Workflow Chainlink CRE (TS)
supabase/
  functions/
    wallet-auth         # Phantom signature → JWT
    process-document    # CNH OCR via Claude Vision
    score-credit        # score V5 preview (NÃO assina — só calcula)
    request-loan        # score + cria loan_request + assina Ed25519 attestation (LOAN_V01)
    request-payout      # dispatcher legacy: action='release' (Anchor) | 'payout' (Woovi)
    confirm-loan        # espelha tx borrower_request_loan → DB (persiste cpf_hash)
    prepare-repayment   # cobrança Woovi de repagamento
    confirm-repayment   # espelha tx repay_loan → DB (amarra ix ao loan PDA/borrower)
    usdc-to-pix         # valida cash_out on-chain → dispara Pix (anti double-spend)
    get-credit-status   # score/limite/juros correntes do user
    get-home            # agrega loan ativo + atividade + saldo + chave Pix (authed)
    dev-reset           # limpa estado do user (gateado por ENVIRONMENT, dev only)
    woovi-webhook       # callback Woovi (HMAC)
    _shared/
      anchor-signer.ts  # raw tx server-side (legacy release; sem IDL)
  migrations/           # 0001-0010 (cpf_pepper, cpf_hash UNIQUE, repayment, cashout guard)
.sdd/uber-money-v2/
  01-requirements.md
  02-design.md          # arquitetura + §security + §migrations
  03-tasks.md
  decisions/
    DR-001-squad-audit.md
    DR-002-squad-anchor-refactor.md
    DR-003-v9-mock-honest.md
```

## Caps de segurança (defense-in-depth)
| Camada | Cap | Onde |
|---|---|---|
| User-facing | **R$ 10 por payout** | `PAYOUT_MAX_BRL` env nas edges `request-loan` + `request-payout` |
| On-chain ceiling | **10 USDC** (≈ R$ 50) | `MAX_AMOUNT_USDC` em `lib.rs:18` |
| Vault pre-fund (demo) | **20 USDC** | manual transfer Phantom → vault token account |

User-facing cap dispara primeiro. On-chain cap só protege se cap edge for bypassed (ex: admin keypair comprometida).

## Decisões trancadas (plan v9 Tainan TG 6554, 27/05 12:25Z)
- **Q5** Hash CPF on-chain. PDA `[loan, sha256(cpf)]` — refinado pra pepper per-user em DR-002 (`users.cpf_pepper` random 32B no signup, vault Supabase only).
- **Q8** Pix flow 2 steps: Efetuar (`release_loan` Anchor) + Sacar (Woovi pix-out).
- **Q21** CRE GO-COM-DEADLINE → MOCK declarado (DR-003).
- **Q22** Off-ramp trigger flow B: front clica Sacar → edge direto.
- **Q24** Phantom only (drop Privy/Google/Uber OAuth).
- **Q25** Helius devnet RPC + QuickNode failover.
- **Q27** Solana devnet (não testnet).

## LGPD — frase defensável (pitch jury)
> "Nosso contrato armazena um hash com pepper do CPF — **pseudonimização por design conforme LGPD art.13 §4º**. O CPF real fica exclusivamente no backend. Em produção migramos para identificador opaco sem nenhuma relação matemática com o CPF, eliminando o risco residual de reversão."

## Trust assumptions (transparência pré-pitch)
- **Oráculo de score = authority keypair.** A edge computa o score e o **oracle assina uma attestation Ed25519** (`LOAN_V01` borrow / `REPAY_V1` repay) verificada on-chain via sysvar instructions. O contrato amarra pubkey, mensagem e assinatura à mesma instrução (`instruction_index == 0xFFFF`), fechando forja — prova on-chain em `scripts/smoke-repay-forgery.ts`. Em produção: pubkey do CRE no lugar do authority.
- **Motorista é Signer** (DR-004 F+). O borrower chama `borrower_request_loan`/`repay_loan` direto via Phantom; a attestation amarra o desembolso ao `cpf_hash` + pubkey do motorista.
- **Sem CCIP no MVP.** Solana-only: desembolso é on-chain direto via `borrower_request_loan`. CCIP cross-chain fica como roadmap v2 (assinatura compatível com `ccip_receive`).
- **`release_loan` legacy é admin-only** (`has_one = authority`, sem attestation/Chainlink) — só roda com `VITE_ONCHAIN_FLOW=false`. Mesma raiz de confiança do oráculo (authority == oracle keypair). Em produção: remover ou exigir a mesma attestation.

### Limitações on-chain conhecidas (red-team interno, não-bloqueantes pro MVP)
- **`repay_nonce` é gravado mas não checado on-chain.** Replay é barrado hoje por `status == Active` + 1-loan-por-CPF (PDA única por `cpf_hash`). Se a v2 permitir múltiplos loans por CPF, o nonce precisa ser enforçado (ou seed da PDA com counter).
- **`cash_out` não tem estado terminal.** Move USDC do motorista PRA o vault (prejudica o motorista, não o protocolo) e é gateado off-chain por `cashout_intents` (índice único, fail-closed antes de qualquer Pix). v2: flipar `status` p/ `CashedOut`.
- **Circuit breaker lê feed devnet stale (~$22).** O guard `SOL < $10` está sempre verde; o valor está em provar a CPI real (programa + feed pinados), não em halt de mercado real.

## Status (31/05/2026 — deployado em prod ✅)
- ✅ Anchor program **DEPLOYADO em devnet** (program ID acima)
- ✅ Vault inicializado + pre-funded com 20 USDC oficial
- ✅ Smoke test on-chain passou (1 USDC transferido pelo programa)
- ✅ Edge `request-payout` (com Anchor signer server-side raw tx) deployada
- ✅ Edge `wallet-auth` (fix DR-003: sem `session_id` fake) deployada
- ✅ Edge `process-document` (OCR real via Claude vision) deployada
- ✅ Migration 0005 aplicada (users.cpf_pepper per-user + loans.cpf_hash UNIQUE)
- ✅ Front 6 telas atomic design + 2-step UX (`Efetuar` → `Sacar`)
- ✅ Wallet UX: Phantom only, autoConnect=false, dedupe signMessage
- ✅ Helius RPC + QuickNode failover env (Q25 v9)
- ✅ CRE workflow score validado via `cre workflow simulate` (DON sandbox)
- ✅ Vercel deploy em prod (https://ubermoney.devfellowship.com)
- ⏳ Vídeo Plano B 60s (Samuel grava)
- ⏳ USDC return (DR-003 D3: adiado, migration 0006 prep feita)

## Time
Daniel Santos · Carlos Eduardo de Paula Nunes · Ryan.
