import { Pill } from '@/components/atoms/pill'
import type { PillTone } from '@/components/atoms/pill'
import type { ScoreBreakdownDecision } from '@/types/domain'

interface ScoreBreakdownProps {
  breakdown: ScoreBreakdownDecision
}

type Rating = 'boa' | 'media' | 'ruim'

const LABELS: Record<keyof ScoreBreakdownDecision, string> = {
  tempo_uber: 'Tempo na Uber',
  dias_semana: 'Dias/semana',
  corridas_semana: 'Corridas/semana',
  fonte_renda: 'Outra renda',
  nota_motorista: 'Nota',
  status_veiculo: 'Veículo',
  negativacao: 'Nome limpo',
}

const RATING_TONE: Record<Rating, PillTone> = {
  boa: 'accent',
  media: 'mute',
  ruim: 'danger',
}

const RATING_LABEL: Record<Rating, string> = {
  boa: 'Boa',
  media: 'Média',
  ruim: 'Ruim',
}

export function ScoreBreakdown({ breakdown }: ScoreBreakdownProps) {
  const entries = Object.entries(breakdown) as [keyof ScoreBreakdownDecision, Rating][]

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, 1fr)',
      gap: 18,
    }}>
      {entries.map(([key, rating]) => (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 7 }}>
          <span style={{ fontSize: 13, color: 'var(--mute)', fontWeight: 500 }}>{LABELS[key]}</span>
          <Pill tone={RATING_TONE[rating]} size="md">{RATING_LABEL[rating]}</Pill>
        </div>
      ))}
    </div>
  )
}
