import { useCallback, useMemo, useState } from 'react'
import { AMOUNT_DEFAULT, AMOUNT_MAX, AMOUNT_MIN } from '@/consts/credit'
import { scoreCredit } from '@/lib/api'
import type {
  FonteRenda,
  LoanReasonId,
  LoanRequestPayload,
  Negativacao,
  ScoreResult,
  StatusVeiculo,
} from '@/types/api'
import type { ProfileValue } from './_components/profile-picker'

export type RequestStep = 'valor' | 'perfil' | 'confirmar'

interface UseRequestScreenInput {
  onSubmit: (payload: LoanRequestPayload) => void
}

interface UseRequestScreenOutput {
  step: RequestStep
  amount: number
  setAmount: (n: number) => void
  reason: LoanReasonId | null
  setReason: (r: LoanReasonId) => void
  otherText: string
  setOtherText: (s: string) => void
  profile: ProfileValue
  updateProfile: (patch: Partial<ProfileValue>) => void
  stepValid: boolean
  goNext: () => void
  goBack: () => void
  scoring: boolean
  scoreError: string | null
  scoreResult: ScoreResult | null
  submit: () => void
}

const EMPTY_PROFILE: ProfileValue = {
  tempo_uber_meses: null,
  dias_semana: null,
  corridas_semana: null,
  fonte_renda: null,
  nota_motorista: null,
  status_veiculo: null,
  negativacao: null,
}

function isCompleteProfile(p: ProfileValue): p is {
  tempo_uber_meses: number
  dias_semana: number
  corridas_semana: number
  fonte_renda: FonteRenda
  nota_motorista: number
  status_veiculo: StatusVeiculo
  negativacao: Negativacao
} {
  return p.tempo_uber_meses !== null
    && p.dias_semana !== null
    && p.corridas_semana !== null
    && p.fonte_renda !== null
    && p.nota_motorista !== null
    && Number.isFinite(p.nota_motorista)
    && p.nota_motorista > 0
    && p.status_veiculo !== null
    && p.negativacao !== null
}

export function useRequestScreen({ onSubmit }: UseRequestScreenInput): UseRequestScreenOutput {
  const [step, setStep] = useState<RequestStep>('valor')
  const [amount, setAmount] = useState(AMOUNT_DEFAULT)
  const [reason, setReason] = useState<LoanReasonId | null>(null)
  const [otherText, setOtherText] = useState('')
  const [profile, setProfile] = useState<ProfileValue>(EMPTY_PROFILE)
  const [scoring, setScoring] = useState(false)
  const [scoreError, setScoreError] = useState<string | null>(null)
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null)

  const updateProfile = useCallback((patch: Partial<ProfileValue>) => {
    setProfile((p) => ({ ...p, ...patch }))
    setScoreResult(null)
    setScoreError(null)
  }, [])

  const valorValid = useMemo(
    () => amount >= AMOUNT_MIN
      && amount <= AMOUNT_MAX
      && reason !== null
      && (reason !== 'outro' || otherText.trim().length >= 3),
    [amount, reason, otherText],
  )

  const perfilValid = useMemo(() => isCompleteProfile(profile), [profile])

  const confirmarValid = useMemo(
    () => scoreResult !== null && scoreResult.approved,
    [scoreResult],
  )

  const stepValid = step === 'valor' ? valorValid : step === 'perfil' ? perfilValid : confirmarValid

  const buildPayload = useCallback((): LoanRequestPayload | null => {
    if (!reason || !isCompleteProfile(profile)) return null
    return {
      amountBRL: amount,
      reason,
      otherText: reason === 'outro' ? otherText.trim() : undefined,
      tempo_uber_meses: profile.tempo_uber_meses,
      dias_semana: profile.dias_semana,
      corridas_semana: profile.corridas_semana,
      fonte_renda: profile.fonte_renda,
      nota_motorista: profile.nota_motorista,
      status_veiculo: profile.status_veiculo,
      negativacao: profile.negativacao,
    }
  }, [amount, reason, otherText, profile])

  const fetchScore = useCallback(async () => {
    const payload = buildPayload()
    if (!payload) return
    setScoring(true)
    setScoreError(null)
    try {
      const result = await scoreCredit(payload, (cre) => {
        setScoreResult((prev) => (prev ? { ...prev, cre } : prev))
      })
      setScoreResult(result)
    } catch (e) {
      setScoreError(e instanceof Error ? e.message : 'Falha ao consultar score.')
    } finally {
      setScoring(false)
    }
  }, [buildPayload])

  const goNext = useCallback(() => {
    if (step === 'valor') {
      if (!valorValid) return
      setStep('perfil')
      return
    }
    if (step === 'perfil') {
      if (!perfilValid) return
      setStep('confirmar')
      void fetchScore()
      return
    }
  }, [step, valorValid, perfilValid, fetchScore])

  const goBack = useCallback(() => {
    if (step === 'confirmar') {
      setStep('perfil')
      setScoreResult(null)
      setScoreError(null)
      return
    }
    if (step === 'perfil') {
      setStep('valor')
    }
  }, [step])

  const submit = useCallback(() => {
    if (step !== 'confirmar' || !confirmarValid) return
    const payload = buildPayload()
    if (!payload) return
    onSubmit(payload)
  }, [step, confirmarValid, buildPayload, onSubmit])

  return {
    step,
    amount, setAmount,
    reason, setReason,
    otherText, setOtherText,
    profile, updateProfile,
    stepValid,
    goNext, goBack,
    scoring, scoreError, scoreResult,
    submit,
  }
}
