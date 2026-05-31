export type LoanReasonId = 'pneu' | 'suspensao' | 'bateria_chupeta' | 'bateria_troca' | 'troca_oleo' | 'outro'
export type FonteRenda = 'so_uber' | 'uber_secundaria' | 'uber_principal'
export type StatusVeiculo = 'financiado' | 'alugado' | 'proprio'
export type Negativacao = 'sim' | 'ja_teve' | 'nao'

export interface LoanRequestPayload {
  amountBRL: number
  reason: LoanReasonId
  otherText?: string
  tempo_uber_meses: number
  dias_semana: number
  corridas_semana: number
  fonte_renda: FonteRenda
  nota_motorista: number
  status_veiculo: StatusVeiculo
  negativacao: Negativacao
}

export interface ScoreBreakdown {
  tempo_uber: 'boa' | 'media' | 'ruim'
  dias_semana: 'boa' | 'media' | 'ruim'
  corridas_semana: 'boa' | 'media' | 'ruim'
  fonte_renda: 'boa' | 'media' | 'ruim'
  nota_motorista: 'boa' | 'media' | 'ruim'
  status_veiculo: 'boa' | 'media' | 'ruim'
  negativacao: 'boa' | 'media' | 'ruim'
}

export interface ScoreResult {
  approved: boolean
  rejection_reason: string | null
  score: number
  breakdown: ScoreBreakdown
  limit_brl: number
  interest_pct: number
  installments: number
  approved_amount_brl: number
  cre?: CreDecision
}

export interface CreDecision {
  loanDecisionPda: string
  borrowerWallet: string
  cpfHashHex: string
  [k: string]: unknown
}

export interface RepayAttestationPayload {
  signatureHex: string
  messageHex: string
  expiresAt: number
  nonceHex: string
  loanPdaBase58: string
  borrowerBase58: string
  amountPaidUsdc: string
  oraclePubkeyBase58: string
}

export interface PrepareRepaymentRequest {
  loanId: string
}

export interface PrepareRepaymentResponse {
  payoutId: string
  correlationId: string
  brcode: string
  qrCodeImage: string
  amountBRL: number
  amountUSDC: string
  loanPda: string
  status: 'pending' | 'confirmed'
  mode: 'mock' | 'sandbox' | 'prod'
  expiresAt: string | null
  attestation: RepayAttestationPayload | null
}

export interface ConfirmRepaymentRequest {
  loanId: string
  txRepay: string
}

export interface ConfirmRepaymentResponse {
  loanId: string
  status: 'paid'
  txRepay: string
  repaidAt: string
  explorer: string
}
