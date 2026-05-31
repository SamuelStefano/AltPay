import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import bs58 from 'bs58'
import { Screen } from '@/components/atoms/screen'
import { Button } from '@/components/atoms/button'
import { getNonce, verifyWallet } from '@/lib/api'

const URL_ = import.meta.env.VITE_SUPABASE_URL as string

export function DevResetScreen() {
  const wallet = useWallet()
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [out, setOut] = useState<{ ok: boolean; msg: string } | null>(null)

  const connected = wallet.publicKey?.toBase58()

  const connect = async () => {
    setConnecting(true)
    try {
      const phantom = wallet.wallets.find((w) => w.adapter.name === 'Phantom')
      if (!phantom) {
        setOut({ ok: false, msg: 'Phantom não detectada' })
        return
      }
      if (wallet.wallet?.adapter?.name !== 'Phantom') {
        wallet.select(phantom.adapter.name)
        const start = Date.now()
        while (Date.now() - start < 1200) {
          if (wallet.wallet?.adapter?.name === 'Phantom') break
          await new Promise((r) => setTimeout(r, 30))
        }
      }
      try {
        await wallet.connect()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/WalletNotSelected/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 300))
          await wallet.connect()
        } else throw e
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/reject|cancel|denied|user/i.test(msg)) setOut({ ok: false, msg })
    } finally {
      setConnecting(false)
    }
  }

  const run = async () => {
    if (!connected) return
    setBusy(true); setOut(null); setConfirming(false)
    try {
      if (!wallet.signMessage) {
        setOut({ ok: false, msg: 'Carteira não suporta assinatura' })
        return
      }
      // dev-reset exige JWT (withAuth + checa ownership da wallet): autentica antes.
      const { nonce, message } = await getNonce(connected)
      const sig = await wallet.signMessage(new TextEncoder().encode(message))
      const { access_token } = await verifyWallet(connected, nonce, bs58.encode(sig))
      const r = await fetch(`${URL_}/functions/v1/dev-reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ wallet: connected }),
      })
      const data = await r.json()
      setOut({ ok: r.ok, msg: data.note ?? (r.ok ? 'Carteira resetada' : data.error ?? 'Erro') })
      if (r.ok) {
        try { await wallet.disconnect() } catch { /* noop */ }
      }
    } catch (e) {
      setOut({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen label="dev/reset" scroll>
      <div style={{ flex: 1, padding: '40px 48px', maxWidth: 520, margin: '0 auto', width: '100%' }}>
        <h1 className="tight" style={{ fontSize: 32, fontWeight: 800, margin: 0, letterSpacing: '-0.025em' }}>
          Reset de carteira
        </h1>
        <p style={{ marginTop: 8, color: 'var(--mute)', fontSize: 14, lineHeight: 1.5 }}>
          Apaga loans, payouts, snapshots, documentos, storage e auth.users
          da carteira conectada. PDAs on-chain não são tocadas.
        </p>

        {!connected ? (
          <div style={{ marginTop: 24 }}>
            <Button variant="accent" size="lg" loading={connecting} onClick={connect} full>
              Conectar Phantom
            </Button>
          </div>
        ) : (
          <div style={{
            marginTop: 24, padding: 16, borderRadius: 12,
            background: 'rgba(10,10,15,0.04)', border: '1px solid var(--line)',
            fontSize: 12, fontWeight: 500, color: 'var(--mute)',
            fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
            wordBreak: 'break-all',
          }}>
            {connected}
          </div>
        )}

        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {confirming ? (
            <>
              <div style={{
                padding: 14, borderRadius: 12,
                background: 'rgba(245,166,35,0.10)', color: '#A66800',
                border: '1px solid rgba(245,166,35,0.30)',
                fontSize: 13, fontWeight: 600,
              }}>
                Vai apagar tudo dessa carteira. Confirma?
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <Button variant="danger" size="lg" loading={busy} onClick={run} style={{ flex: 1 }}>
                  Sim, resetar
                </Button>
                <Button variant="secondary" size="lg" onClick={() => setConfirming(false)} style={{ flex: 1 }}>
                  Cancelar
                </Button>
              </div>
            </>
          ) : (
            <Button variant="accent" size="lg" disabled={!connected || busy} onClick={() => setConfirming(true)}>
              Resetar minha carteira
            </Button>
          )}
        </div>

        {out && (
          <div style={{
            marginTop: 20, padding: 14, borderRadius: 12,
            background: out.ok ? 'var(--accent-soft)' : 'rgba(220,60,60,0.06)',
            color: out.ok ? 'var(--accent-deep)' : '#B23A3A',
            border: `1px solid ${out.ok ? 'rgba(0,194,110,0.20)' : 'rgba(220,60,60,0.18)'}`,
            fontSize: 13, fontWeight: 600,
          }}>
            {out.ok ? '✓ ' : '✗ '}{out.msg}{out.ok ? ' — pode reconectar a Phantom pra cadastrar do zero.' : ''}
          </div>
        )}
      </div>
    </Screen>
  )
}
