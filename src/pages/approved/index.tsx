import { Screen } from '@/components/atoms/screen'
import { Sheet } from '@/components/molecules/sheet'
import { Receipt } from '@/components/molecules/receipt'
import { useApprovedScreen } from './use-approved-screen'
import { ApprovedHero } from './_components/approved-hero'
import { ConfettiLayer } from './_components/confetti-layer'
import { PixNotification } from './_components/pix-notification'
import { PixKeyModal } from './_components/pix-key-modal'
import type { LoanDecision } from '@/types/domain'

interface ApprovedScreenProps {
  decision: LoanDecision
  onHome: () => void
  onRepay?: () => void
}

export function ApprovedScreen({ decision, onHome, onRepay }: ApprovedScreenProps) {
  const a = useApprovedScreen({ decision })
  if (!decision) return null

  return (
    <Screen label="05 Approved" style={{ background: '#FAFAF8' }}>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        <div style={{
          minHeight: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '40px 24px', position: 'relative',
        }}>
          <ConfettiLayer dots={a.confetti} />
          <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
            <ApprovedHero
              decision={decision}
              phase={a.phase}
              release={a.release}
              onEfetuar={a.efetuar}
              onSacar={a.sacar}
              onShowReceipt={() => a.setShowReceipt(true)}
              onHome={onHome}
              onRepay={onRepay}
            />
          </div>
          <PixNotification show={a.showNotif} amountBRL={a.receipt?.amountBRL ?? decision.approvedAmountBRL} />
        </div>

        <Sheet open={a.showReceipt} onClose={() => a.setShowReceipt(false)}>
          {a.receipt && <Receipt receipt={a.receipt} decision={decision} onClose={() => a.setShowReceipt(false)} />}
        </Sheet>

        <PixKeyModal
          open={a.showPixModal}
          onClose={a.closePixModal}
          onConfirm={a.confirmPix}
          amountBRL={decision.approvedAmountBRL}
        />
      </div>
    </Screen>
  )
}
