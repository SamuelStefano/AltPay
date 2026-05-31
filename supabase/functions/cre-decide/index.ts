import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { json } from '../_shared/cors.ts'
import { admin } from '../_shared/admin.ts'
import { withAuth } from '../_shared/with-auth.ts'
import { normalizeScoreBody } from '../_shared/normalize-score-body.ts'
import { deriveCpfHash } from '../_shared/cpf-hash.ts'
import { bufToHex, base58Decode } from '../_shared/crypto.ts'
import { PublicKey } from '../_shared/anchor-signer.ts'

const RECEIVER_PROGRAM_ID = new PublicKey(
  Deno.env.get('RECEIVER_PROGRAM_ID') ?? '2Bji2TPoZs5mJrPN2HQJdszTQAP9EMuo1Bqd4t74ged2',
)
const DECISION_SEED = new TextEncoder().encode('decision')

serve((req) => withAuth(req, async (req, user) => {
  const bridgeUrl = Deno.env.get('BRIDGE_URL')
  const bridgeSecret = Deno.env.get('BRIDGE_SECRET')
  if (!bridgeUrl || !bridgeSecret) return json({ error: 'bridge not configured' }, 500, req)

  let raw: Record<string, unknown>
  try { raw = (await req.json()) as Record<string, unknown> } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  const inputs = await normalizeScoreBody(raw, user.id)
  if ('error' in inputs) return json(inputs, 400, req)

  const cpf = await deriveCpfHash(admin, user.id)
  if (!cpf.ok) return json({ error: cpf.error }, cpf.status, req)

  const { data: userRow } = await admin.from('users').select('wallet').eq('id', user.id).maybeSingle()
  const wallet = typeof userRow?.wallet === 'string' ? userRow.wallet : null
  if (!wallet) return json({ error: 'User wallet not set' }, 400, req)

  let borrowerSol32: Uint8Array
  try {
    borrowerSol32 = base58Decode(wallet)
  } catch {
    return json({ error: 'Invalid wallet base58' }, 400, req)
  }
  if (borrowerSol32.length !== 32) return json({ error: 'Wallet not 32 bytes' }, 400, req)

  const [decisionPda] = PublicKey.findProgramAddressSync([DECISION_SEED, cpf.cpfHash], RECEIVER_PROGRAM_ID)

  const payload = {
    cpfHash: '0x' + bufToHex(cpf.cpfHash),
    borrowerSol32: '0x' + bufToHex(borrowerSol32),
    loanDecisionPda32: '0x' + bufToHex(decisionPda.toBytes()),
    faturamento_mensal_brl: inputs.faturamento_mensal_brl,
    amount_brl: inputs.amount_brl,
    tempo_uber_meses: inputs.tempo_uber_meses,
    dias_semana: inputs.dias_semana,
    corridas_semana: inputs.corridas_semana,
    fonte_renda: inputs.fonte_renda,
    nota_motorista: inputs.nota_motorista,
    status_veiculo: inputs.status_veiculo,
    negativacao: inputs.negativacao,
    repaid_loans_count: inputs.repaid_loans_count,
  }

  let bridgeResp: Response
  try {
    bridgeResp = await fetch(`${bridgeUrl.replace(/\/$/, '')}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-secret': bridgeSecret },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return json({ error: 'bridge unreachable: ' + (e instanceof Error ? e.message : String(e)) }, 502, req)
  }

  const bridgeBody = await bridgeResp.json().catch(() => null) as
    | { ok?: boolean; decision?: Record<string, unknown>; error?: string }
    | null
  if (!bridgeResp.ok || !bridgeBody?.ok || !bridgeBody.decision) {
    return json({ error: bridgeBody?.error ?? 'bridge error', status: bridgeResp.status }, 502, req)
  }

  const decision = bridgeBody.decision
  return json({
    ...decision,
    loanDecisionPda: decisionPda.toBase58(),
    borrowerWallet: wallet,
    cpfHashHex: cpf.cpfHashHex,
  }, 200, req)
}))
