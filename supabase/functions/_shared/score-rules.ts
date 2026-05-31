import { CREDIT_LIMIT_MAX_BRL } from './limits.ts'

export type Resposta = 'boa' | 'media' | 'ruim'

export type FinalidadeId =
  | 'pneu'
  | 'suspensao'
  | 'bateria_chupeta'
  | 'bateria_troca'
  | 'troca_oleo'
  | 'outro'

export type FonteRenda = 'so_uber' | 'uber_secundaria' | 'uber_principal'
export type StatusVeiculo = 'financiado' | 'alugado' | 'proprio'
export type Negativacao = 'sim' | 'ja_teve' | 'nao'

export interface ScoreInputs {
  faturamento_mensal_brl: number
  amount_brl: number
  finalidade_id: FinalidadeId
  tempo_uber_meses: number
  dias_semana: number
  corridas_semana: number
  fonte_renda: FonteRenda
  nota_motorista: number
  status_veiculo: StatusVeiculo
  negativacao: Negativacao
  repaid_loans_count?: number
}

export interface ScoreBreakdown {
  tempo_uber: Resposta
  dias_semana: Resposta
  corridas_semana: Resposta
  fonte_renda: Resposta
  nota_motorista: Resposta
  status_veiculo: Resposta
  negativacao: Resposta
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
}

export interface FinalidadeSpec {
  id: FinalidadeId
  label: string
  min_brl: number
  max_brl: number
}

export const FINALIDADES: Record<FinalidadeId, FinalidadeSpec> = {
  pneu: { id: 'pneu', label: 'Trocar pneu', min_brl: 30, max_brl: 200 },
  suspensao: { id: 'suspensao', label: 'Consertar suspensão', min_brl: 1000, max_brl: 4000 },
  bateria_chupeta: { id: 'bateria_chupeta', label: 'Chupeta (bateria)', min_brl: 40, max_brl: 70 },
  bateria_troca: { id: 'bateria_troca', label: 'Trocar bateria', min_brl: 250, max_brl: 700 },
  troca_oleo: { id: 'troca_oleo', label: 'Trocar óleo', min_brl: 100, max_brl: 300 },
  outro: { id: 'outro', label: 'Outro', min_brl: 30, max_brl: 10000 },
}

const BASE_INTEREST = 0.025
const MAX_INTEREST = 0.049
const POINTS_PER: Record<Resposta, number> = { boa: 3, media: 2, ruim: 1 }
const MAX_POINTS = 21

// Limite de crédito = 10% da média salarial (faturamento dos últimos 6 meses).
// O dinheiro REAL sacável continua capado em MONEY_CAP_BRL (cappedBRL/brlToUsdc).
function creditLimitFor(faturamentoMensalBRL: number): number {
  return Math.min(Math.round(faturamentoMensalBRL * 0.10), CREDIT_LIMIT_MAX_BRL)
}

function classifyTempo(meses: number): Resposta {
  if (meses >= 12) return 'boa'
  if (meses >= 6) return 'media'
  return 'ruim'
}

function classifyDias(dias: number): Resposta {
  if (dias > 4) return 'boa'
  if (dias >= 3) return 'media'
  return 'ruim'
}

function classifyCorridas(corridas: number): Resposta {
  if (corridas >= 50) return 'boa'
  if (corridas >= 30) return 'media'
  return 'ruim'
}

function classifyFonte(fonte: FonteRenda): Resposta {
  if (fonte === 'uber_principal') return 'boa'
  if (fonte === 'uber_secundaria') return 'media'
  return 'ruim'
}

function classifyNota(nota: number): Resposta {
  if (nota >= 4.85) return 'boa'
  if (nota >= 4.8) return 'media'
  return 'ruim'
}

function classifyVeiculo(status: StatusVeiculo): Resposta {
  if (status === 'proprio') return 'boa'
  if (status === 'alugado') return 'media'
  return 'ruim'
}

function classifyNegativacao(neg: Negativacao): Resposta {
  if (neg === 'nao') return 'boa'
  if (neg === 'ja_teve') return 'media'
  return 'ruim'
}

function installmentsFor(amountBRL: number): number {
  if (amountBRL <= 3) return 1
  if (amountBRL <= 7) return 2
  return 3
}

function emptyBreakdown(): ScoreBreakdown {
  return {
    tempo_uber: 'ruim',
    dias_semana: 'ruim',
    corridas_semana: 'ruim',
    fonte_renda: 'ruim',
    nota_motorista: 'ruim',
    status_veiculo: 'ruim',
    negativacao: 'ruim',
  }
}

export function computeScoreV5(inputs: ScoreInputs): ScoreResult {
  const breakdown: ScoreBreakdown = {
    tempo_uber: classifyTempo(inputs.tempo_uber_meses),
    dias_semana: classifyDias(inputs.dias_semana),
    corridas_semana: classifyCorridas(inputs.corridas_semana),
    fonte_renda: classifyFonte(inputs.fonte_renda),
    nota_motorista: classifyNota(inputs.nota_motorista),
    status_veiculo: classifyVeiculo(inputs.status_veiculo),
    negativacao: classifyNegativacao(inputs.negativacao),
  }

  if (inputs.negativacao === 'sim') {
    return {
      approved: false,
      rejection_reason: 'Nome negativado — não emprestamos.',
      score: 0,
      breakdown,
      limit_brl: 0,
      interest_pct: MAX_INTEREST,
      installments: 1,
      approved_amount_brl: 0,
    }
  }

  const points = (Object.values(breakdown) as Resposta[]).reduce((acc, r) => acc + POINTS_PER[r], 0)
  const score = Math.round((points / MAX_POINTS) * 1000)

  const baseRatio = inputs.negativacao === 'nao' ? 0.10 : 0.05
  const limit_brl = creditLimitFor(inputs.faturamento_mensal_brl)

  if (inputs.amount_brl > limit_brl) {
    return {
      approved: false,
      rejection_reason: 'Valor excede o limite disponível.',
      score,
      breakdown,
      limit_brl,
      interest_pct: MAX_INTEREST,
      installments: installmentsFor(inputs.amount_brl),
      approved_amount_brl: 0,
    }
  }

  const scoreFactor = (1 - score / 1000) * (MAX_INTEREST - BASE_INTEREST)
  const ratio = limit_brl > 0 ? inputs.amount_brl / inputs.faturamento_mensal_brl : 0
  const ratioFactor = Math.min(ratio / baseRatio, 1) * 0.005
  const interest_pct = Math.min(BASE_INTEREST + scoreFactor + ratioFactor, MAX_INTEREST)

  return {
    approved: true,
    rejection_reason: null,
    score,
    breakdown,
    limit_brl,
    interest_pct,
    installments: installmentsFor(inputs.amount_brl),
    approved_amount_brl: inputs.amount_brl,
  }
}

export function validateScoreInputs(body: unknown): ScoreInputs | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid body' }
  const b = body as Record<string, unknown>

  const faturamento_mensal_brl = Number(b.faturamento_mensal_brl)
  const amount_brl = Number(b.amount_brl)
  const finalidade_id = b.finalidade_id as FinalidadeId
  const tempo_uber_meses = Number(b.tempo_uber_meses)
  const dias_semana = Number(b.dias_semana)
  const corridas_semana = Number(b.corridas_semana)
  const fonte_renda = b.fonte_renda as FonteRenda
  const nota_motorista = Number(b.nota_motorista)
  const status_veiculo = b.status_veiculo as StatusVeiculo
  const negativacao = b.negativacao as Negativacao

  if (!Number.isFinite(faturamento_mensal_brl) || faturamento_mensal_brl <= 0) return { error: 'faturamento_mensal_brl invalido' }
  if (!Number.isFinite(amount_brl) || amount_brl <= 0) return { error: 'amount_brl invalido' }
  if (!FINALIDADES[finalidade_id]) return { error: 'finalidade_id invalido' }
  if (!Number.isFinite(tempo_uber_meses) || tempo_uber_meses < 0) return { error: 'tempo_uber_meses invalido' }
  if (!Number.isFinite(dias_semana) || dias_semana < 0 || dias_semana > 7) return { error: 'dias_semana invalido' }
  if (!Number.isFinite(corridas_semana) || corridas_semana < 0) return { error: 'corridas_semana invalido' }
  if (!['so_uber', 'uber_secundaria', 'uber_principal'].includes(fonte_renda)) return { error: 'fonte_renda invalido' }
  if (!Number.isFinite(nota_motorista) || nota_motorista < 0 || nota_motorista > 5) return { error: 'nota_motorista invalido' }
  if (!['financiado', 'alugado', 'proprio'].includes(status_veiculo)) return { error: 'status_veiculo invalido' }
  if (!['sim', 'ja_teve', 'nao'].includes(negativacao)) return { error: 'negativacao invalido' }

  const repaidRaw = Number(b.repaid_loans_count)
  const repaid_loans_count = Number.isFinite(repaidRaw) && repaidRaw > 0 ? Math.floor(repaidRaw) : 0

  return {
    faturamento_mensal_brl,
    amount_brl,
    finalidade_id,
    tempo_uber_meses,
    dias_semana,
    corridas_semana,
    fonte_renda,
    nota_motorista,
    status_veiculo,
    negativacao,
    repaid_loans_count,
  }
}

export const _internals = { emptyBreakdown, installmentsFor }
