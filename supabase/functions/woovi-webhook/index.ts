import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { jsonOpen as json, handleOptionsOpen as handleOptions } from '../_shared/cors.ts'
import { admin } from '../_shared/admin.ts'
import { generateAndStoreRepayAttestation } from '../_shared/repay-attestation.ts'

const WEBHOOK_SECRET = Deno.env.get('WOOVI_WEBHOOK_SECRET')
const INSECURE_MODE = Deno.env.get('WOOVI_WEBHOOK_INSECURE_MODE') === 'true'
const LOCAL_DEV = Deno.env.get('LOCAL_DEV') === 'true'
const ENVIRONMENT = Deno.env.get('ENVIRONMENT')
const ALLOWED_INSECURE_ENVS = new Set(['sandbox', 'staging', 'local'])

if (INSECURE_MODE && !LOCAL_DEV && !ALLOWED_INSECURE_ENVS.has(ENVIRONMENT ?? '')) {
  console.error('[woovi-webhook] INSECURE_MODE bloqueado: ENVIRONMENT fora da whitelist', { ENVIRONMENT })
  throw new Error('WOOVI_WEBHOOK_INSECURE_MODE=true exige ENVIRONMENT in {sandbox,staging,local} ou LOCAL_DEV=true')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return handleOptions()
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const raw = await req.text()

  if (INSECURE_MODE) {
    // Sandbox temp: aceita sem HMAC. Loga headers pra capturar o formato Woovi sandbox.
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => { headers[k] = v })
    console.warn('[woovi-webhook] INSECURE_MODE=true (sandbox)', { headers, bodyPreview: raw.slice(0, 300) })
  } else {
    // Fail-closed em prod: sem secret = misconfigured
    if (!WEBHOOK_SECRET) return json({ error: 'Webhook misconfigured (missing WOOVI_WEBHOOK_SECRET)' }, 500)
    const auth = req.headers.get('authorization') ?? req.headers.get('x-webhook-authorization') ?? ''
    if (!timingSafeEqual(auth, WEBHOOK_SECRET)) return json({ error: 'Unauthorized' }, 401)
  }

  let payload: Record<string, any>
  try { payload = JSON.parse(raw) } catch { return json({ error: 'Invalid JSON' }, 400) }

  // Teste de webhook do painel Woovi (ping) — não tem correlationID, só responde OK
  if (payload.evento === 'teste_webhook' || payload.event === 'teste_webhook') {
    console.log('[woovi-webhook] ping recebido', payload)
    return json({ received: true, ping: true })
  }

  const transfer = payload.transfer ?? payload.charge ?? payload
  const correlationId: string | undefined = transfer.correlationID ?? transfer.correlationId
  const wooviStatus: string | undefined = transfer.status ?? payload.status
  const endToEndId: string | undefined = transfer.endToEndId ?? transfer.endtoendId

  if (!correlationId) return json({ error: 'Missing correlationID' }, 400)

  const completed = wooviStatus && /COMPLETED|CONFIRMED|PAID|SUCCESS/i.test(wooviStatus)
  const failed = wooviStatus && /FAILED|ERROR|DENIED|REJECTED/i.test(wooviStatus)
  const localStatus = completed ? 'confirmed' : failed ? 'failed' : 'pending'

  // DR-001 / A4 CRIT-2: COMPLETED depois de FAILED é cenário real (sandbox flakey) — aceitar.
  // FAILED só atualiza se ainda pending. CONFIRMED nunca volta atrás.
  const allowedFromStatuses = localStatus === 'confirmed' ? ['pending', 'failed'] : ['pending']
  const { data: updated, error: updErr } = await admin
    .from('payouts')
    .update({ status: localStatus, endtoend_id: endToEndId ?? null, woovi_payload: payload })
    .eq('woovi_correlation_id', correlationId)
    .in('status', allowedFromStatuses)
    .select('id, loan_id, kind')
    .maybeSingle()

  if (updErr) return json({ error: updErr.message }, 500)

  if (updated && localStatus === 'confirmed' && updated.kind === 'repay') {
    // Gera RepayAttestation Ed25519 pra front re-assinar tx Anchor repay_loan.
    // NÃO marca loans.status='paid' aqui — só confirm-repayment faz isso após tx onchain confirmar.
    await generateAndStoreRepayAttestation(updated.id, updated.loan_id)
  }

  return json({ received: true, correlationId, status: localStatus })
})
