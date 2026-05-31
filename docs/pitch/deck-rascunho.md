# Deck pitch — AltPay (rascunho 10 slides)

**Formato:** 16:9 ou 9:16 (vertical pro pitch presencial Bienal). Keynote/Slides.
**Tempo de pitch:** ~3 min vivo + 2-3 min Q&A.
**Audience:** Jury Solana (Super Team) + Jury Chainlink (Solange Gueiros) + Tainan + público hackathon.

---

## Slide 1 — Capa
- **Logo AltPay** central
- **Tagline:** "Crédito na hora, pra quem roda."
- **Subtitle:** Hackanation 2026 · Solana + Chainlink · RWA
- **Time:** Daniel Santos · Carlos Eduardo de Paula Nunes · Ryan
- Footer: 4 selos sponsor (Solana / Chainlink / Woovi / DFL)

---

## Slide 2 — O Problema
**Headline:** "9 milhões de motoristas, R$50 que faltam pra rodar"

Bullets:
- Furou o pneu/gasolina/manutenção urgente → motorista pára de rodar
- Banco: 24-72h pra aprovar empréstimo
- SPC: 30% dos motoristas restritos
- App de empréstimo: juro 10-30% ao mês

**Imagem:** foto motorista pneu furado no acostamento

---

## Slide 3 — A Solução (1 frase)
**Headline:** "Empréstimo on-chain em segundos. Score IA + Chainlink. Pix cai no banco."

```
Motorista (Phantom) → Upload print Uber → Score Chainlink CRE
→ Anchor escrow PDA → USDC devnet → Pix Woovi (R$ real)
```

**Tempo médio aprovação:** 6,4s · **Juros a partir de:** 2,9%/mês · **SPC:** zero consulta

---

## Slide 4 — Arquitetura
**Diagrama:**

```
┌──────────────┐    ┌───────────────┐    ┌─────────────────┐
│   Front      │    │   Supabase    │    │  Anchor program │
│ Vite+React   │───▶│  Edge Fns     │───▶│  release_loan() │
│ Phantom only │    │  + Postgres   │    │  PDA[loan,hash] │
└──────────────┘    └───────────────┘    └─────────────────┘
       │                    │                      │
       │                    ▼                      ▼
       │            ┌───────────────┐    ┌─────────────────┐
       │            │ Chainlink CRE │    │  USDC devnet    │
       │            │ score WASM    │    │  + Vault PDA    │
       │            └───────────────┘    └─────────────────┘
       │                                          │
       ▼                                          ▼
┌──────────────┐                          ┌─────────────────┐
│   Woovi      │  ◀───────────────────────│ admin_disburse  │
│  Pix REAL    │       (off-ramp)         │ MOCK CCIP recv  │
└──────────────┘                          └─────────────────┘
```

---

## Slide 5 — On-chain (Solana track)
**Headline:** "1 ix Anchor, 1 PDA por CPF, USDC devnet"

| Item | Valor |
|---|---|
| Program ID | `6m2ipcrUCRpSqkPSqNNKNH11rNmVsu8KmnBLnBtFsq2N` |
| Instruction | `release_loan(cpf_hash, amount, score)` |
| PDA seed | `[b"loan", sha256(cpf‖pepper_per_user)]` |
| Anti-duplo | PDA `init` falha hard + UNIQUE off-chain |
| Vault | `AE5KWqjhDGNRvk4bV4nEJGbcSy15eAWVVazHyPsjbnxz` |
| USDC fundado | 20 USDC oficial Circle |
| Smoke tx | [2TyJskPWqYy…vB9j](https://explorer.solana.com/tx/2TyJskPWqYyBpYevdN5iBDEoZ1GjZ5yKyKW29spaS2aEhh8mhXqmSgK4Rrfqjkvk7p3XjFJV1MDkGVxksxiHvB9j?cluster=devnet) |

**Defense-in-depth:** cap user R$10 / cap on-chain 10 USDC (~R$50).

---

## Slide 6 — Chainlink (CRE track)
**Headline:** "CRE workflow score + CCIP-compatible receiver"

| Camada | Estado |
|---|---|
| CRE workflow TS → WASM | ✅ `binary.wasm` compila |
| `computeScore` (zod + threshold 600) | ✅ |
| CCIP `admin_disburse` instruction | ✅ assinatura compat `Any2SolanaMessage` |
| Smoke MOCK CCIP receiver | ✅ [3jY9w3GLMHg…FeYiu](https://explorer.solana.com/tx/3jY9w3GLMHgcpC1QY7uDT51yDnp5BBJpKJrL9UZLWp5UCqJysBqCzD3KMwajC6EoSmQVovcgkwwB4WASoGfFeYiu?cluster=devnet) |

**Honestidade declarada:** Por restrição de tempo de hackathon, último hop (CCIP→Solana router) é admin-triggered. Arquitetura E2E demonstrada em 2 paths on-chain reais + roadmap CCIP nativo v2.

---

## Slide 7 — Live demo
**Headline:** "Pix bipando na sua mão"

(Slide com QR code do https://faucet.solana.com pro jurado pegar SOL devnet OU mockup do app)

**Roteiro 30s ao vivo:**
1. Samsung do Tainan na cena
2. Samuel conecta Phantom no celular
3. Pede R$ 1 com motivo "Pneu"
4. CRE simulate roda → score 720
5. Clica "Efetuar" → tx Solana confirma (link Explorer mostra)
6. Clica "Sacar Pix" → Pix REAL bipa no celular de outro jurado em &lt;15s

---

## Slide 8 — Tese RWA + LGPD
**Headline:** "Crédito produtivo é RWA; pseudonimização é LGPD-compliant"

- **RWA:** o ativo é a renda futura do motorista (~R$ 3.000/mês). Score off-chain valida. Empréstimo on-chain executa.
- **LGPD art.13 §4º:** pseudonimização — hash com pepper per-user. CPF nunca on-chain em texto claro.
- **Frase defensável:** "Em produção migramos pra UUID opaco sem reversibilidade — pepper-per-user é demo-grade."

---

## Slide 9 — Stack & Sponsors
**Headline:** "8 tecnologias, 0 wasted"

| Camada | Tech | Sponsor |
|---|---|---|
| Front | Vite + React 19 + Tailwind 4 | — |
| Wallet | `@solana/wallet-adapter` Phantom | Solana |
| Backend | Supabase Edge Fns + Postgres + JWT | — |
| On-chain | Anchor 0.30 + USDC devnet | Solana |
| Oráculo | CRE workflow TS → WASM + admin_disburse | Chainlink |
| Off-ramp | Woovi PROD (mock fallback) | Woovi |
| RPC | Helius devnet + QuickNode failover | Helius |
| LGPD | hash+pepper art.13 §4º | DFL |

---

## Slide 10 — O time + próximos passos
**Equipe:**
- **Daniel Santos**
- **Carlos Eduardo de Paula Nunes**
- **Ryan**

**Roadmap v2 (pós-hackathon):**
- CCIP receiver real (router program SVM)
- Multisig vault (Squads)
- Wallet-embedded onboarding pra motorista comum (não-cripto-native)
- Mainnet deploy + parcerias com cooperativas Uber

**Closing:**
> "Microcrédito produtivo para 9 milhões de motoristas. Funcionando hoje em devnet. Pronto pra escalar."

---

## Critérios pré-pitch
- [ ] Tx hashes atualizados (release_loan smoke + admin_disburse smoke + deploy)
- [ ] Vídeo 60s gravado e revisado
- [ ] URL Vercel pública pro Taikai submit
- [ ] CRE_API_KEY pegada + screenshot simulate
- [ ] Ensaio cronometrado (3min vivo + Q&A)
- [ ] Plano B vídeo offline no laptop (rede Bienal pode falhar)
