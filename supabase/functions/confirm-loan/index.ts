import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { json } from '../_shared/cors.ts'
import { admin } from '../_shared/admin.ts'
import { withAuth } from '../_shared/with-auth.ts'
import { deriveCpfHash } from '../_shared/cpf-hash.ts'

const PROGRAM_ID = Deno.env.get('PROGRAM_ID') ?? '6m2ipcrUCRpSqkPSqNNKNH11rNmVsu8KmnBLnBtFsq2N'
const RPC_URL = Deno.env.get('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com'
const LOAN_TENOR_DAYS = 7

interface RequestBody {
  requestId: string
  txRelease: string
  loanPda?: string
}

interface ResponseBody {
  loanId: string
  status: 'open'
  txRelease: string
  explorer: string
}

serve((req) => withAuth(req, async (req, user) => {
  let body: RequestBody
  try { body = await req.json() as RequestBody } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  if (!body.requestId || !body.txRelease) return json({ error: 'requestId and txRelease required' }, 400, req)

  const { data: existing } = await admin
    .from('loans')
    .select('id, tx_release, status')
    .eq('request_id', body.requestId)
    .maybeSingle()
  if (existing) {
    const resp: ResponseBody = {
      loanId: existing.id,
      status: 'open',
      txRelease: existing.tx_release ?? body.txRelease,
      explorer: explorerFor(existing.tx_release ?? body.txRelease),
    }
    return json(resp, 200, req)
  }

  const { data: request, error: reqErr } = await admin
    .from('loan_requests')
    .select('id, user_id, amount_brl, interest_pct, status, cpf_hash')
    .eq('id', body.requestId)
    .maybeSingle()
  if (reqErr || !request) return json({ error: 'loan_request not found' }, 404, req)
  if (request.user_id !== user.id) return json({ error: 'Forbidden' }, 403, req)
  if (request.status !== 'approved') return json({ error: 'loan_request not approved' }, 400, req)

  const onChain = await verifyTxOnChain(body.txRelease)
  if (!onChain.ok) return json({ error: onChain.error }, 400, req)

  // No flow on-chain (F+) o motorista assina request_loan direto: cpf_hash nunca
  // passou por request-payout. Deriva e persiste aqui senão prepare-repayment trava.
  let cpfHashHex = (request.cpf_hash as string | null) ?? null
  if (!cpfHashHex) {
    const derived = await deriveCpfHash(admin, user.id)
    if (!derived.ok) return json({ error: derived.error }, derived.status, req)
    cpfHashHex = derived.cpfHashHex
    await admin.from('loan_requests').update({ cpf_hash: cpfHashHex }).eq('id', body.requestId)
  }

  // PDA derivado no cliente (deterministico de cpf_hash + program). Verificamos
  // só a existência on-chain via RPC — sem carregar web3.js, que estoura o isolate (546).
  let loanPda: string | null = null
  if (body.loanPda) {
    const exists = await pdaExistsOnChain(body.loanPda)
    if (!exists) return json({ error: 'Loan PDA not found on-chain' }, 400, req)
    loanPda = body.loanPda
  }

  const dueDate = new Date(Date.now() + LOAN_TENOR_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const insertRow: Record<string, unknown> = {
    request_id: body.requestId,
    principal_brl: request.amount_brl,
    interest_pct: request.interest_pct,
    due_date: dueDate,
    status: 'open',
    tx_release: body.txRelease,
    cpf_hash: cpfHashHex,
    on_chain_pda: loanPda,
  }

  const { data: loan, error: loanErr } = await admin
    .from('loans')
    .insert(insertRow)
    .select('id')
    .single()
  if (loanErr) {
    const { data: race } = await admin
      .from('loans').select('id, tx_release').eq('request_id', body.requestId).maybeSingle()
    if (race) {
      const resp: ResponseBody = {
        loanId: race.id,
        status: 'open',
        txRelease: race.tx_release ?? body.txRelease,
        explorer: explorerFor(race.tx_release ?? body.txRelease),
      }
      return json(resp, 200, req)
    }
    return json({ error: loanErr.message }, 500, req)
  }

  const resp: ResponseBody = {
    loanId: loan.id,
    status: 'open',
    txRelease: body.txRelease,
    explorer: explorerFor(body.txRelease),
  }
  return json(resp, 200, req)
}))

async function verifyTxOnChain(txSig: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [txSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
      }),
    })
    const data = await r.json() as { result?: { meta?: { err?: unknown }, transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } } } }
    const tx = data.result
    if (!tx) return { ok: false, error: 'tx not found on-chain' }
    if (tx.meta?.err) return { ok: false, error: `tx failed on-chain: ${JSON.stringify(tx.meta.err)}` }
    const keys = (tx.transaction?.message?.accountKeys ?? []) as Array<string | { pubkey: string }>
    const programInvolved = keys.some((k) => (typeof k === 'string' ? k : k.pubkey) === PROGRAM_ID)
    if (!programInvolved) return { ok: false, error: `tx does not invoke program ${PROGRAM_ID}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `RPC error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function pdaExistsOnChain(loanPdaB58: string): Promise<boolean> {
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [loanPdaB58, { commitment: 'confirmed', encoding: 'base64' }],
      }),
    })
    const data = await r.json() as { result?: { value?: { owner?: string } | null } }
    const value = data.result?.value
    return Boolean(value && value.owner === PROGRAM_ID)
  } catch {
    return false
  }
}

function explorerFor(sig: string): string {
  const cluster = RPC_URL.includes('devnet') ? 'devnet' : RPC_URL.includes('testnet') ? 'testnet' : 'mainnet-beta'
  return `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`
}
