export const BRL_PER_USDC = 5
export const USDC_DECIMALS = 1_000_000

// Teto do limite de crédito que o motor de score concede (valor EXIBIDO ao motorista).
export const CREDIT_LIMIT_MAX_BRL = Number(Deno.env.get('CREDIT_LIMIT_MAX_BRL') ?? '10000')

// Teto do dinheiro REAL que se move on-chain (USDC desembolsado/devolvido) e via Pix.
// Mantém abaixo do MAX_AMOUNT_USDC (10 USDC = R$50) do contrato; demo capa em R$1.
export const MONEY_CAP_BRL = Number(Deno.env.get('PAYOUT_MAX_BRL') ?? '1')

export function brlToUsdc(amountBRL: number): bigint {
  const capped = Math.min(amountBRL, MONEY_CAP_BRL)
  return BigInt(Math.round(capped * USDC_DECIMALS / BRL_PER_USDC))
}

export function cappedBRL(amountBRL: number): number {
  return Math.min(amountBRL, MONEY_CAP_BRL)
}

export function usdcToBrl(amountUSDC: bigint): number {
  return Number(amountUSDC) * BRL_PER_USDC / USDC_DECIMALS
}
