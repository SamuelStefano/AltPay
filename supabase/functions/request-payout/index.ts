import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { json } from '../_shared/cors.ts'
import { admin } from '../_shared/admin.ts'
import { withAuth } from '../_shared/with-auth.ts'
import { isValidCpf } from '../_shared/cpf.ts'
import { cappedBRL } from '../_shared/limits.ts'
import { WOOVI_BASE_URL, WOOVI_MODE } from '../_shared/woovi.ts'

const WOOVI_API_KEY = Deno.env.get('WOOVI_API_KEY') ?? ''

type PayoutBody = { action: 'payout'; loanId: string; pixKey: string; pixKeyType: 'cpf' | 'email' | 'phone' | 'evp' }

serve((req) => withAuth(req, async (req, user) => {
  let body: PayoutBody
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  if (body.action !== 'payout') return json({ error: 'Invalid action — expected "payout"' }, 400, req)
  return handlePayout(req, admin, user.id, body)
}))

async function handlePayout(req: Request, admin: SupabaseClient, userId: string, body: PayoutBody) {
  if (!body.loanId || !body.pixKey || !body.pixKeyType) {
    return json({ error: 'loanId, pixKey, pixKeyType required' }, 400, req)
  }

  const { data: loan, error: loanErr } = await admin
    .from('loans')
    .select('id, status, principal_brl, request_id, tx_release, loan_requests!inner(user_id)')
    .eq('id', body.loanId)
    .maybeSingle()
  if (loanErr || !loan) return json({ error: 'Loan not found' }, 404, req)
  if ((loan as any).loan_requests.user_id !== userId) return json({ error: 'Forbidden' }, 403, req)
  if (loan.status !== 'open') return json({ error: 'Loan not open' }, 400, req)

  // Anti double-spend: tx_release (setado por confirm-loan E release_loan legacy)
  // significa que o USDC já foi pro wallet do motorista on-chain. O único Pix
  // legítimo é via usdc-to-pix, que exige o cash_out devolvendo o USDC ao vault.
  // O Pix legacy aqui pagaria sem o swap-back → dinheiro em dobro.
  if (loan.tx_release) {
    return json({ error: 'Loan disbursed on-chain; cash out via on-chain swap-back, not legacy Pix' }, 409, req)
  }
  const { data: cashout } = await admin.from('cashout_intents')
    .select('id').eq('loan_id', body.loanId).neq('status', 'failed').limit(1)
  if (cashout?.length) return json({ error: 'Loan already cashed out on-chain' }, 409, req)

  if (body.pixKeyType === 'cpf') {
    const { data: cnhDoc } = await admin
      .from('documents').select('ocr_data').eq('user_id', userId).eq('kind', 'cnh').maybeSingle()
    const ocrCpf = (cnhDoc?.ocr_data as any)?.cpf
    const norm = (s: string) => s.replace(/\D/g, '')
    if (!ocrCpf || norm(ocrCpf) !== norm(body.pixKey)) {
      return json({ error: 'pixKey CPF does not match CNH on file' }, 403, req)
    }
  }

  const amountBRL = cappedBRL(Number(loan.principal_brl))
  const amountCents = Math.round(amountBRL * 100)

  const { data: existing } = await admin
    .from('payouts')
    .select('id, status, amount_brl, woovi_correlation_id')
    .eq('loan_id', body.loanId)
    .eq('kind', 'release')
    .in('status', ['pending', 'confirmed'])
    .maybeSingle()
  if (existing) {
    let finalStatus = existing.status
    if (existing.status === 'pending' && (WOOVI_MODE === 'sandbox' || WOOVI_MODE === 'mock')) {
      const { error: confirmErr } = await admin.from('payouts').update({
        status: 'confirmed',
        endtoend_id: `SANDBOX-${(existing.woovi_correlation_id ?? existing.id).slice(0, 8)}`,
      }).eq('id', existing.id).eq('status', 'pending')
      if (!confirmErr) finalStatus = 'confirmed'
    }
    return json({
      payoutId: existing.id,
      status: finalStatus,
      correlationId: existing.woovi_correlation_id ?? '',
      amountBRL: Number(existing.amount_brl),
      mode: WOOVI_MODE,
      resumed: true,
    }, 200, req)
  }

  const correlationId = crypto.randomUUID()

  const { data: payout, error: payoutErr } = await admin
    .from('payouts')
    .insert({
      loan_id: body.loanId, kind: 'release', amount_brl: amountBRL,
      pix_key: body.pixKey, pix_key_type: body.pixKeyType,
      status: 'pending', woovi_correlation_id: correlationId,
    })
    .select('id')
    .single()
  if (payoutErr) return json({ error: payoutErr.message }, 500, req)

  if (WOOVI_MODE === 'mock') {
    // EdgeRuntime mata o isolate ao retornar — sem waitUntil o setTimeout nunca
    // dispara e o payout fica preso em 'pending'.
    const confirmLater = new Promise<void>((resolve) => setTimeout(async () => {
      try {
        await admin.from('payouts').update({
          status: 'confirmed',
          woovi_payload: { mocked: true, correlationId, paidAt: new Date().toISOString() },
        }).eq('id', payout.id)
      } catch (e) { console.error('[mock] update failed', e) } finally { resolve() }
    }, 8000))
    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(confirmLater)
    return json({
      payoutId: payout.id, status: 'pending', correlationId, amountBRL,
      mode: 'mock', note: 'Confirmed in ~8s via mock background update.',
    }, 200, req)
  }

  const { data: cnhDocForCustomer } = await admin
    .from('documents').select('ocr_data').eq('user_id', userId).eq('kind', 'cnh').maybeSingle()
  const cnhOcr = cnhDocForCustomer?.ocr_data as { cpf?: string; name?: string } | null
  const customerCpf = (cnhOcr?.cpf ?? '').replace(/\D/g, '')
  const customerName = cnhOcr?.name?.trim()
  const { data: authUser } = await admin.auth.admin.getUserById(userId)
  const customerEmail = authUser?.user?.email
  const customerPhone = authUser?.user?.phone

  const customer: Record<string, string> = { name: customerName || 'Motorista AltPay' }
  const candidateCpf = (customerCpf && customerCpf.length === 11)
    ? customerCpf
    : (body.pixKeyType === 'cpf' ? body.pixKey.replace(/\D/g, '') : '')
  if (candidateCpf && isValidCpf(candidateCpf)) {
    customer.taxID = candidateCpf
  } else if (candidateCpf) {
    console.warn('[payout] CPF candidato falhou checksum, omitindo taxID')
  }
  if (customerEmail) customer.email = customerEmail
  else if (body.pixKeyType === 'email') customer.email = body.pixKey
  if (customerPhone) customer.phone = customerPhone
  else if (body.pixKeyType === 'phone') customer.phone = body.pixKey

  if (!customer.taxID && !customer.email && !customer.phone) {
    return json({ error: 'Customer needs valid CPF, email or phone (none available)' }, 400, req)
  }

  try {
    const wooviRes = await fetch(`${WOOVI_BASE_URL}/charge`, {
      method: 'POST',
      headers: { 'Authorization': WOOVI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        correlationID: correlationId,
        value: amountCents,
        comment: `AltPay - emprestimo ${body.loanId.slice(0, 8)}`,
        customer,
      }),
      signal: AbortSignal.timeout(25_000),
    })
    const wooviText = await wooviRes.text()
    let wooviData: any = null
    try { wooviData = JSON.parse(wooviText) } catch { /* keep raw */ }

    if (!wooviRes.ok) {
      await admin.from('payouts').update({ status: 'failed', error_message: wooviText, woovi_payload: wooviData }).eq('id', payout.id)
      return json({ error: 'Woovi error', status: wooviRes.status, details: wooviText }, 502, req)
    }

    if (WOOVI_MODE === 'sandbox') {
      await admin.from('payouts').update({
        status: 'confirmed',
        endtoend_id: `SANDBOX-${correlationId.slice(0, 8)}`,
        woovi_payload: { ...wooviData, sandbox_auto_confirmed_at: new Date().toISOString() },
      }).eq('id', payout.id)
      return json({ payoutId: payout.id, status: 'confirmed', correlationId, amountBRL, mode: WOOVI_MODE }, 200, req)
    }

    await admin.from('payouts').update({ woovi_payload: wooviData }).eq('id', payout.id)
    return json({ payoutId: payout.id, status: 'pending', correlationId, amountBRL, mode: WOOVI_MODE }, 200, req)
  } catch (e) {
    await admin.from('payouts').update({ status: 'failed', error_message: String(e) }).eq('id', payout.id)
    return json({ error: 'Network error', details: String(e) }, 502, req)
  }
}
