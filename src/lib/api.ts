import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { ActivityItem, LoanDecision, PayoutReceipt, ScoreBreakdownDecision } from '@/types/domain'
import type { LoanRequestPayload, ScoreResult, CreDecision, PrepareRepaymentRequest, PrepareRepaymentResponse, ConfirmRepaymentRequest, ConfirmRepaymentResponse } from '@/types/api'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const HAS_BACKEND = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

let _supabase: SupabaseClient | null = null
export function supabase(): SupabaseClient {
  if (!_supabase) {
    if (!HAS_BACKEND) throw new Error('Backend not configured (VITE_SUPABASE_URL missing)')
    _supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, { auth: { persistSession: true } })
  }
  return _supabase
}

const fnUrl = (name: string) => `${SUPABASE_URL}/functions/v1/${name}`

// JWT mintado por wallet-auth é custom (sem session em auth.sessions).
// Supabase JS `setSession` rejeita silenciosamente esse token, então armazenamos
// em memória aqui e usamos no authedFetch.
let _walletAccessToken: string | null = null
export function setWalletAccessToken(token: string | null) { _walletAccessToken = token }
export function getWalletAccessToken(): string | null { return _walletAccessToken }

async function authedFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const token = _walletAccessToken
    || (await supabase().auth.getSession()).data.session?.access_token
    || SUPABASE_ANON_KEY
  return fetch(fnUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  })
}

export async function getNonce(wallet: string): Promise<{ nonce: string; message: string }> {
  const r = await fetch(fnUrl('wallet-auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_nonce', wallet }),
  })
  if (!r.ok) throw new Error(`get_nonce: ${r.status}`)
  return r.json()
}

export async function verifyWallet(wallet: string, nonce: string, signatureB58: string): Promise<{ access_token: string; user_id: string }> {
  const r = await fetch(fnUrl('wallet-auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'verify', wallet, nonce, signature: signatureB58 }),
  })
  if (!r.ok) throw new Error(`verify: ${r.status} ${await r.text()}`)
  const data = await r.json()
  if (data.access_token) {
    setWalletAccessToken(data.access_token)
    try {
      await supabase().auth.setSession({ access_token: data.access_token, refresh_token: '' })
    } catch (_) { /* ignore — usamos _walletAccessToken como fonte da verdade */ }
  }
  return data
}

export type DocKind = 'cnh' | 'print_earnings'

export class NotACnhError extends Error {
  constructor(public detail: string) { super(detail); this.name = 'NotACnhError' }
}

export async function processDocument(kind: DocKind, imageBase64: string, mediaType = 'image/jpeg') {
  const r = await authedFetch('process-document', { kind, imageBase64, mediaType })
  if (!r.ok) {
    const body = await r.text()
    if (r.status === 422 && body.includes('not_a_cnh')) {
      try {
        const parsed = JSON.parse(body) as { message?: string }
        throw new NotACnhError(parsed.message ?? 'A imagem não é uma CNH.')
      } catch (e) {
        if (e instanceof NotACnhError) throw e
        throw new NotACnhError('A imagem não é uma CNH.')
      }
    }
    throw new Error(`process-document: ${r.status} ${body}`)
  }
  return r.json() as Promise<{ document_id: string; kind: DocKind; ocr_data: any }>
}

export interface CreditStatus {
  has_request: boolean
  has_cnh: boolean
  has_earnings: boolean
  score: number | null
  limit_brl: number | null
  interest_pct: number | null
  last_request_at?: string
  last_status?: string
}

export async function getCreditStatus(): Promise<CreditStatus> {
  const r = await authedFetch('get-credit-status', {})
  if (!r.ok) throw new Error(`get-credit-status: ${r.status} ${await r.text()}`)
  return r.json()
}

const REASON_MAP: Record<string, 'emergency' | 'vehicle_repair' | 'fuel' | 'other'> = {
  pneu: 'vehicle_repair',
  suspensao: 'vehicle_repair',
  bateria_chupeta: 'vehicle_repair',
  bateria_troca: 'vehicle_repair',
  troca_oleo: 'vehicle_repair',
  outro: 'other',
}

interface LoanRequestResponse {
  approved: boolean
  score: number
  approvedAmountBRL: number
  limit_brl: number
  interestPct: number
  installments: number
  dueDate: string | null
  requestId: string
  attestation: ScoreAttestation | null
  score_breakdown?: ScoreBreakdownDecision
}

export async function requestLoan(payload: LoanRequestPayload): Promise<LoanDecision> {
  const mapped = REASON_MAP[payload.reason] ?? 'other'
  const body = {
    amountBRL: payload.amountBRL,
    reason: mapped,
    otherText: payload.otherText,
    tempo_uber_meses: payload.tempo_uber_meses,
    dias_semana: payload.dias_semana,
    corridas_semana: payload.corridas_semana,
    fonte_renda: payload.fonte_renda,
    nota_motorista: payload.nota_motorista,
    status_veiculo: payload.status_veiculo,
    negativacao: payload.negativacao,
  }
  const r = await authedFetch('request-loan', body)
  if (!r.ok) throw new Error(`request-loan: ${r.status} ${await r.text()}`)
  const data: LoanRequestResponse = await r.json()
  return {
    approved: data.approved,
    score: data.score,
    approvedAmountBRL: data.approvedAmountBRL,
    installments: data.installments,
    interestPct: data.interestPct,
    dueDate: data.dueDate ?? new Date().toISOString(),
    loanId: '',
    requestId: data.requestId,
    attestation: data.attestation ?? undefined,
    limit_brl: data.limit_brl,
    score_breakdown: data.score_breakdown,
  }
}

export async function scoreCredit(
  inputs: LoanRequestPayload,
  onCre?: (cre: CreDecision) => void,
): Promise<ScoreResult> {
  const body = {
    amountBRL: inputs.amountBRL,
    reason: REASON_MAP[inputs.reason] ?? 'other',
    otherText: inputs.otherText,
    tempo_uber_meses: inputs.tempo_uber_meses,
    dias_semana: inputs.dias_semana,
    corridas_semana: inputs.corridas_semana,
    fonte_renda: inputs.fonte_renda,
    nota_motorista: inputs.nota_motorista,
    status_veiculo: inputs.status_veiculo,
    negativacao: inputs.negativacao,
  }
  const r = await authedFetch('score-credit', body)
  if (!r.ok) throw new Error(`score-credit: ${r.status} ${await r.text()}`)
  const result = (await r.json()) as ScoreResult
  if (onCre) {
    void creDecide(body).then((cre) => { if (cre) onCre(cre) })
  }
  return result
}

const CRE_DECIDE_TIMEOUT_MS = 90_000

async function creDecide(body: unknown): Promise<CreDecision | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CRE_DECIDE_TIMEOUT_MS)
  try {
    const r = await authedFetch('cre-decide', body, ctrl.signal)
    if (!r.ok) return null
    return (await r.json()) as CreDecision
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface ConfirmLoanResponse {
  loanId: string
  status: 'open'
  txRelease: string
  explorer: string
}

export async function confirmLoan(requestId: string, txRelease: string, loanPda?: string): Promise<ConfirmLoanResponse> {
  const r = await authedFetch('confirm-loan', { requestId, txRelease, loanPda })
  if (!r.ok) throw new Error(`confirm-loan: ${r.status} ${await r.text()}`)
  return r.json()
}

export type PixKeyType = 'cpf' | 'email' | 'phone' | 'evp'

interface PayoutResponse {
  payoutId: string
  status: 'pending' | 'confirmed'
  correlationId: string
  amountBRL: number
  mode?: 'prod' | 'mock' | 'sandbox'
}

export interface ScoreAttestation {
  requestId: string
  cpfHashHex: string
  cpfHashBytes: number[]
  amountUSDC: string
  score: number
  expiresAt: string
  oraclePubkeyBase58: string
  oraclePubkeyBytes: number[]
  signature: number[]
  messageBytes: number[]
  borrowerWallet: string
}

export async function requestPayout(loanId: string, pixKey: string, pixKeyType: PixKeyType): Promise<PayoutResponse> {
  const r = await authedFetch('request-payout', { action: 'payout', loanId, pixKey, pixKeyType })
  if (!r.ok) throw new Error(`request-payout: ${r.status} ${await r.text()}`)
  return r.json()
}

export interface CashOutToPixResponse {
  payoutId: string
  status: string
  amountBRL: number
  txCashOut: string
  mode: string
  // ausentes no path idempotente (resumed) — só o fluxo fresh os popula
  correlationId?: string
  amountUSDC?: number
  explorer?: string
  resumed?: boolean
}

export async function cashOutToPix(args: {
  loanId: string
  cashOutTxSig: string
  pixKey: string
  pixKeyType: PixKeyType
  clientIntentId: string
}): Promise<CashOutToPixResponse> {
  const r = await authedFetch('usdc-to-pix', args)
  if (!r.ok) throw new Error(`usdc-to-pix: ${r.status} ${await r.text()}`)
  return r.json()
}

interface LoanRow {
  id: string
  principal_brl: number
  interest_pct: number
  due_date: string
  status: string
  created_at: string
  request_id: string | null
}

interface PayoutRow {
  id: string
  amount_brl: number
  kind: string
  pix_key: string
  created_at: string
  endtoend_id: string | null
  loan_id: string
}

export interface HomeState {
  activeLoan: LoanRow | null
  loans: LoanRow[]
  payouts: PayoutRow[]
  balanceBRL: number
  pixKey: string | null
  pixKeyType: PixKeyType | null
}

let inflightHome: Promise<HomeState> | null = null

export async function getHome(): Promise<HomeState> {
  if (inflightHome) return inflightHome
  inflightHome = (async () => {
    const r = await authedFetch('get-home', {})
    if (!r.ok) throw new Error(`get-home: ${r.status} ${await r.text()}`)
    return r.json() as Promise<HomeState>
  })()
  try {
    return await inflightHome
  } finally {
    inflightHome = null
  }
}

export async function getUserActivity(): Promise<ActivityItem[]> {
  const { loans, payouts: allPayouts } = await getHome()
  const payouts = allPayouts.filter((p) => p.kind === 'release')
  const repays = allPayouts.filter((p) => p.kind === 'repay')
  const loanMap = new Map<string, LoanRow>()
  for (const l of loans) loanMap.set(l.id, l)

  const items: ActivityItem[] = []
  const loanIdsWithPix = new Set<string>()
  for (const p of payouts) {
    const loan = loanMap.get(p.loan_id)
    const receipt: PayoutReceipt = {
      id: p.id,
      amountBRL: Number(p.amount_brl),
      to: p.pix_key,
      timestamp: p.created_at,
    }
    const decision: LoanDecision | undefined = loan
      ? {
          approved: true,
          score: 0,
          loanId: loan.id,
          requestId: loan.request_id ?? '',
          approvedAmountBRL: Number(loan.principal_brl),
          interestPct: Number(loan.interest_pct) * 100,
          installments: 3,
          dueDate: loan.due_date,
          loanStatus: loan.status as LoanDecision['loanStatus'],
        }
      : undefined
    items.push({
      id: p.id,
      kind: 'pix',
      amountBRL: Number(p.amount_brl),
      label: 'Pix recebido',
      sub: `Empréstimo ${p.loan_id.slice(0, 8)} · ${p.pix_key}`,
      timestamp: p.created_at,
      receipt,
      decision,
    })
    loanIdsWithPix.add(p.loan_id)
  }
  for (const p of repays) {
    items.push({
      id: p.id,
      kind: 'repay',
      amountBRL: Number(p.amount_brl),
      label: 'Empréstimo pago',
      sub: `Empréstimo ${p.loan_id.slice(0, 8)}`,
      timestamp: p.created_at,
    })
  }
  for (const l of loans) {
    if (loanIdsWithPix.has(l.id)) continue
    items.push({
      id: l.id,
      kind: 'loan',
      amountBRL: Number(l.principal_brl),
      label: 'Empréstimo aberto',
      sub: `${(Number(l.interest_pct) * 100).toFixed(1)}%/mês · vence ${new Date(l.due_date).toLocaleDateString('pt-BR')}`,
      timestamp: l.created_at,
    })
  }
  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return items
}

interface PayoutStatusRow {
  status: 'pending' | 'confirmed' | 'failed'
  endtoend_id: string | null
  amount_brl: number
  created_at: string
  pix_key: string
}

export async function getPayoutStatus(payoutId: string): Promise<PayoutStatusRow | null> {
  const { data } = await supabase()
    .from('payouts')
    .select('status, endtoend_id, amount_brl, created_at, pix_key')
    .eq('id', payoutId)
    .maybeSingle()
  return (data as PayoutStatusRow | null) ?? null
}

export async function pollUntilConfirmed(payoutId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<PayoutReceipt> {
  const interval = opts.intervalMs ?? 2000
  const timeout = opts.timeoutMs ?? 60_000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const row = await getPayoutStatus(payoutId)
    if (row?.status === 'confirmed') {
      return {
        id: row.endtoend_id ?? payoutId,
        amountBRL: Number(row.amount_brl),
        timestamp: row.created_at,
        to: row.pix_key,
      }
    }
    if (row?.status === 'failed') throw new Error('Pix recusado pelo Woovi')
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('Timeout aguardando confirmação do Pix')
}

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

export async function prepareRepayment(loanId: string): Promise<PrepareRepaymentResponse> {
  const r = await authedFetch('prepare-repayment', { loanId } satisfies PrepareRepaymentRequest)
  if (!r.ok) throw new Error(`prepare-repayment: ${r.status} ${await r.text()}`)
  return r.json()
}

export async function confirmRepayment(loanId: string, txRepay: string): Promise<ConfirmRepaymentResponse> {
  const r = await authedFetch('confirm-repayment', { loanId, txRepay } satisfies ConfirmRepaymentRequest)
  if (!r.ok) throw new Error(`confirm-repayment: ${r.status} ${await r.text()}`)
  return r.json()
}
