import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { json } from '../_shared/cors.ts'
import { admin } from '../_shared/admin.ts'
import { withAuth } from '../_shared/with-auth.ts'
import { isValidCpf } from '../_shared/cpf.ts'
import { createCharge, WOOVI_MODE } from '../_shared/woovi.ts'
import { cappedBRL, brlToUsdc } from '../_shared/limits.ts'

const PROGRAM_ID_STR = Deno.env.get('PROGRAM_ID') ?? '6m2ipcrUCRpSqkPSqNNKNH11rNmVsu8KmnBLnBtFsq2N'
// PDA determinística [vault] e mint USDC. Constantes evitam derivar/baixar
// web3.js no isolate — derivação estática a partir do PROGRAM_ID.
const VAULT_PDA = Deno.env.get('VAULT_PDA') ?? '6XPi5Xo6N5Ddq9hpZHzZNGWeQT42Boz1uF6Lwo7Dosrf'
const USDC_MINT = Deno.env.get('USDC_MINT_DEVNET') ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const RPC_URL = Deno.env.get('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com'

interface Body {
  loanId: string
  cashOutTxSig: string
  pixKey: string
  pixKeyType: 'cpf' | 'email' | 'phone' | 'evp'
  clientIntentId: string
}

interface RpcTokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string }
}

// D5: verificação on-chain barata mas honesta. Prova que a tx assinada pelo
// motorista chamou nosso programa E uma conta de token USDC pertencente ao
// vault PDA recebeu >= amount. Usa JSON-RPC cru (fetch) em vez de web3.js —
// carregar web3.js no isolate estoura WORKER_RESOURCE_LIMIT (HTTP 546).
async function verifyCashOut(sig: string, borrowerWallet: string, amountUSDC: bigint): Promise<string | null> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
    }),
  })
  if (!res.ok) return `rpc getTransaction http ${res.status}`
  const tx = (await res.json())?.result
  if (!tx) return 'tx not found on-chain (devnet)'
  if (tx.meta?.err) return `tx failed on-chain: ${JSON.stringify(tx.meta.err)}`

  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: { pubkey: string }) => k.pubkey)
  if (!keys.includes(PROGRAM_ID_STR)) return 'tx does not call uber_money program'
  if (keys[0] !== borrowerWallet) return 'tx fee payer is not the borrower wallet'

  const isVaultUsdc = (b: RpcTokenBalance) => b.owner === VAULT_PDA && b.mint === USDC_MINT
  const pre = (tx.meta?.preTokenBalances as RpcTokenBalance[] | undefined)?.find(isVaultUsdc)
  const post = (tx.meta?.postTokenBalances as RpcTokenBalance[] | undefined)?.find(isVaultUsdc)
  // Sem o saldo pré, preAmt cairia em 0 e um saldo pré-existente alto passaria
  // como se fosse depósito — falso positivo. Exige ambos os snapshots.
  if (!pre || !post) return 'vault token balance snapshot missing in tx metadata'
  const preAmt = BigInt(pre.uiTokenAmount.amount ?? '0')
  const postAmt = BigInt(post.uiTokenAmount.amount ?? '0')
  if (postAmt - preAmt < amountUSDC) return `vault received ${postAmt - preAmt}, expected >= ${amountUSDC}`

  return null
}

serve((req) => withAuth(req, async (req, user) => {
  let body: Body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  if (!body.loanId || !body.cashOutTxSig || !body.pixKey || !body.pixKeyType || !body.clientIntentId) {
    return json({ error: 'loanId, cashOutTxSig, pixKey, pixKeyType, clientIntentId required' }, 400, req)
  }

  const { data: loan, error: loanErr } = await admin
    .from('loans')
    .select('id, status, principal_brl, loan_requests!inner(user_id)')
    .eq('id', body.loanId)
    .maybeSingle()
  if (loanErr || !loan) return json({ error: 'Loan not found' }, 404, req)
  if ((loan as { loan_requests: { user_id: string } }).loan_requests.user_id !== user.id) {
    return json({ error: 'Forbidden' }, 403, req)
  }
  if (loan.status !== 'open') return json({ error: 'Loan not open' }, 400, req)

  if (body.pixKeyType === 'cpf') {
    const { data: cnhDoc } = await admin
      .from('documents').select('ocr_data').eq('user_id', user.id).eq('kind', 'cnh').maybeSingle()
    const ocrCpf = (cnhDoc?.ocr_data as { cpf?: string } | null)?.cpf
    const norm = (s: string) => s.replace(/\D/g, '')
    if (!ocrCpf || norm(ocrCpf) !== norm(body.pixKey)) {
      return json({ error: 'pixKey CPF does not match CNH on file' }, 403, req)
    }
  }

  const amountBRL = cappedBRL(Number(loan.principal_brl))
  const amountUSDC = brlToUsdc(Number(loan.principal_brl))

  const { data: userRow } = await admin.from('users').select('wallet').eq('id', user.id).maybeSingle()
  if (!userRow?.wallet) return json({ error: 'User wallet not registered' }, 400, req)

  // CRIT-1: uma tx cash_out vira Pix uma vez; um loan saca uma vez.
  // Retry idempotente com mesmo client_intent_id devolve o payout existente —
  // NUNCA re-cobra. Intent diferente sobre mesma sig/loan = replay → 409.
  const { data: sameIntent } = await admin.from('cashout_intents')
    .select('id, pix_payout_id, status, amount_brl').eq('source', 'uber_money')
    .eq('client_intent_id', body.clientIntentId).neq('status', 'failed').maybeSingle()
  if (sameIntent) {
    return json({
      payoutId: sameIntent.pix_payout_id ?? '',
      status: sameIntent.status,
      amountBRL: Number(sameIntent.amount_brl),
      txCashOut: body.cashOutTxSig,
      mode: WOOVI_MODE,
      resumed: true,
    }, 200, req)
  }
  const { data: sigDup } = await admin.from('cashout_intents')
    .select('id').eq('source', 'uber_money').eq('solana_signature', body.cashOutTxSig)
    .neq('status', 'failed').neq('client_intent_id', body.clientIntentId).limit(1)
  if (sigDup?.length) return json({ error: 'cash_out tx already consumed' }, 409, req)
  const { data: loanDup } = await admin.from('cashout_intents')
    .select('id').eq('source', 'uber_money').eq('loan_id', body.loanId)
    .neq('status', 'failed').neq('client_intent_id', body.clientIntentId).limit(1)
  if (loanDup?.length) return json({ error: 'loan already cashed out' }, 409, req)

  const verifyErr = await verifyCashOut(body.cashOutTxSig, userRow.wallet, amountUSDC)
  if (verifyErr) {
    await admin.from('cashout_intents').upsert({
      source: 'uber_money', client_intent_id: body.clientIntentId, user_id: user.id,
      loan_id: body.loanId, amount_usdc: Number(amountUSDC), amount_brl: amountBRL,
      pix_key: body.pixKey, pix_key_type: body.pixKeyType,
      solana_signature: body.cashOutTxSig, status: 'failed', error_message: verifyErr,
    }, { onConflict: 'source,client_intent_id' })
    return json({ error: 'cash_out verification failed', details: verifyErr }, 422, req)
  }

  // CRIT-1 fix: grava o intent uniqueness-bearing (usdc_received) ANTES de
  // inserir payout / chamar Woovi. Os índices únicos parciais (sig, loan_id) da
  // migration 0010 fecham a corrida ANTES de qualquer Pix sair. Usa INSERT puro
  // (fail-closed) — não upsert DO UPDATE, senão o perdedor de uma corrida com
  // mesmo client_intent_id seguiria pra uma segunda cobrança. Tentativa anterior
  // 'failed' é apagada antes pra um retry legítimo reclamar o slot.
  const correlationId = crypto.randomUUID()
  await admin.from('cashout_intents').delete()
    .eq('source', 'uber_money').eq('client_intent_id', body.clientIntentId).eq('status', 'failed')
  const { error: intentErr } = await admin.from('cashout_intents').insert({
    source: 'uber_money', client_intent_id: body.clientIntentId, user_id: user.id,
    loan_id: body.loanId, amount_usdc: Number(amountUSDC), amount_brl: amountBRL,
    pix_key: body.pixKey, pix_key_type: body.pixKeyType,
    solana_signature: body.cashOutTxSig, status: 'usdc_received',
  })
  if (intentErr) {
    if (intentErr.code === '23505') {
      const { data: winner } = await admin.from('cashout_intents')
        .select('pix_payout_id, status, amount_brl').eq('source', 'uber_money')
        .eq('client_intent_id', body.clientIntentId).neq('status', 'failed').maybeSingle()
      if (winner) {
        return json({
          payoutId: winner.pix_payout_id ?? '', status: winner.status,
          amountBRL: Number(winner.amount_brl), txCashOut: body.cashOutTxSig,
          mode: WOOVI_MODE, resumed: true,
        }, 200, req)
      }
      return json({ error: 'cash_out already consumed' }, 409, req)
    }
    return json({ error: intentErr.message }, 500, req)
  }

  const { data: payout, error: payoutErr } = await admin
    .from('payouts')
    .insert({
      loan_id: body.loanId, kind: 'release', amount_brl: amountBRL,
      pix_key: body.pixKey, pix_key_type: body.pixKeyType,
      status: 'pending', woovi_correlation_id: correlationId,
    })
    .select('id')
    .single()
  if (payoutErr) {
    // libera o slot pro retry — senão o intent fica preso em 'usdc_received' sem payout
    await admin.from('cashout_intents').update({ status: 'failed', error_message: payoutErr.message })
      .eq('source', 'uber_money').eq('client_intent_id', body.clientIntentId)
    return json({ error: payoutErr.message }, 500, req)
  }

  await admin.from('cashout_intents').update({ pix_payout_id: payout.id })
    .eq('source', 'uber_money').eq('client_intent_id', body.clientIntentId)

  await admin.from('users').update({ pix_key: body.pixKey, pix_key_type: body.pixKeyType }).eq('id', user.id)

  const { data: cnhForName } = await admin
    .from('documents').select('ocr_data').eq('user_id', user.id).eq('kind', 'cnh').maybeSingle()
  const customerName = (cnhForName?.ocr_data as { name?: string } | null)?.name?.trim()

  let charge
  try {
    charge = await createCharge({
      correlationId,
      amountBRL,
      comment: `AltPay - saque emprestimo ${body.loanId.slice(0, 8)}`,
      customer: { name: customerName || 'Motorista AltPay', ...(body.pixKeyType === 'cpf' && isValidCpf(body.pixKey.replace(/\D/g, '')) ? { taxID: body.pixKey.replace(/\D/g, '') } : {}) },
    })
  } catch (e) {
    await admin.from('payouts').update({ status: 'failed', error_message: String(e) }).eq('id', payout.id)
    await admin.from('cashout_intents').update({ status: 'pix_failed_refund_due', error_message: String(e) })
      .eq('source', 'uber_money').eq('client_intent_id', body.clientIntentId)
    return json({ error: 'Woovi charge failed', details: String(e) }, 502, req)
  }

  await admin.from('payouts').update({ woovi_payload: charge.raw }).eq('id', payout.id)
  await admin.from('cashout_intents').update({ status: 'pix_dispatched' })
    .eq('source', 'uber_money').eq('client_intent_id', body.clientIntentId)

  if (WOOVI_MODE === 'mock') {
    // EdgeRuntime mata o isolate ao retornar a resposta — sem waitUntil o
    // setTimeout nunca dispara e o payout fica preso em 'pending'.
    const confirmLater = new Promise<void>((resolve) => setTimeout(async () => {
      try {
        await admin.from('payouts').update({
          status: 'confirmed',
          woovi_payload: { mocked: true, correlationId, paidAt: new Date().toISOString() },
        }).eq('id', payout.id)
        await admin.from('cashout_intents').update({ status: 'pix_confirmed' })
          .eq('source', 'uber_money').eq('client_intent_id', body.clientIntentId)
      } catch (e) { console.error('[usdc-to-pix mock] update failed', e) } finally { resolve() }
    }, 8000))
    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(confirmLater)
  }

  return json({
    payoutId: payout.id,
    status: 'pending',
    correlationId,
    amountBRL,
    amountUSDC: Number(amountUSDC),
    txCashOut: body.cashOutTxSig,
    explorer: `https://explorer.solana.com/tx/${body.cashOutTxSig}?cluster=devnet`,
    mode: WOOVI_MODE,
  }, 200, req)
}))
