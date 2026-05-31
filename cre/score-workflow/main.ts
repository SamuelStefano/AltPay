import {
	cre,
	EVMClient,
	type HTTPPayload,
	Runner,
	type Runtime,
} from '@chainlink/cre-sdk'
import { encodeAbiParameters, type Hex } from 'viem'
import { z } from 'zod'

const hexToBase64 = (hex: Hex): string =>
	Buffer.from(hex.slice(2), 'hex').toString('base64')

const configSchema = z.object({
	chainSelectorName: z.string(),
	consumerAddress: z.string(),
	gasLimit: z.string(),
	scoreThreshold: z.number(),
	brlPerUsdc: z.number(),
	moneyCapBRL: z.number(),
	creditLimitMaxBRL: z.number(),
	creditLineBaseBRL: z.number(),
	creditLineStepBRL: z.number(),
	creditLineMaxTiers: z.number(),
	demoRelaxLimit: z.boolean(),
	writableBitmap: z.string(),
})

type Config = z.infer<typeof configSchema>

const inputSchema = z.object({
	cpfHash: z.string(),
	borrowerSol32: z.string(),
	loanDecisionPda32: z.string(),
	faturamento_mensal_brl: z.number(),
	amount_brl: z.number(),
	tempo_uber_meses: z.number(),
	dias_semana: z.number(),
	corridas_semana: z.number(),
	fonte_renda: z.enum(['so_uber', 'uber_secundaria', 'uber_principal']),
	nota_motorista: z.number(),
	status_veiculo: z.enum(['financiado', 'alugado', 'proprio']),
	negativacao: z.enum(['sim', 'ja_teve', 'nao']),
	repaid_loans_count: z.number().optional(),
})

type WorkflowInput = z.infer<typeof inputSchema>

type Resposta = 'boa' | 'media' | 'ruim'

const BASE_INTEREST = 0.025
const MAX_INTEREST = 0.049
const POINTS_PER: Record<Resposta, number> = { boa: 3, media: 2, ruim: 1 }
const MAX_POINTS = 21

const classifyTempo = (m: number): Resposta => (m >= 12 ? 'boa' : m >= 6 ? 'media' : 'ruim')
const classifyDias = (d: number): Resposta => (d > 4 ? 'boa' : d >= 3 ? 'media' : 'ruim')
const classifyCorridas = (c: number): Resposta => (c >= 50 ? 'boa' : c >= 30 ? 'media' : 'ruim')
const classifyFonte = (f: WorkflowInput['fonte_renda']): Resposta =>
	f === 'uber_principal' ? 'boa' : f === 'uber_secundaria' ? 'media' : 'ruim'
const classifyNota = (n: number): Resposta => (n >= 4.85 ? 'boa' : n >= 4.8 ? 'media' : 'ruim')
const classifyVeiculo = (s: WorkflowInput['status_veiculo']): Resposta =>
	s === 'proprio' ? 'boa' : s === 'alugado' ? 'media' : 'ruim'
const classifyNegativacao = (n: WorkflowInput['negativacao']): Resposta =>
	n === 'nao' ? 'boa' : n === 'ja_teve' ? 'media' : 'ruim'

const installmentsFor = (brl: number): number => (brl <= 3 ? 1 : brl <= 7 ? 2 : 3)

const creditLineFor = (repaid: number | undefined, cfg: Config): number => {
	const r = Number.isFinite(repaid) ? Math.max(0, Math.floor(repaid as number)) : 0
	const tier = Math.min(r, cfg.creditLineMaxTiers)
	const line = cfg.creditLineBaseBRL + cfg.creditLineStepBRL * tier
	return Math.max(cfg.moneyCapBRL, Math.min(line, cfg.creditLimitMaxBRL))
}

type Decision = {
	approved: boolean
	rejectionReason: string | null
	score: number
	limitBRL: number
	interestPct: number
	installments: number
	approvedAmountBRL: number
}

function computeScoreV5(input: WorkflowInput, cfg: Config): Decision {
	const breakdown: Resposta[] = [
		classifyTempo(input.tempo_uber_meses),
		classifyDias(input.dias_semana),
		classifyCorridas(input.corridas_semana),
		classifyFonte(input.fonte_renda),
		classifyNota(input.nota_motorista),
		classifyVeiculo(input.status_veiculo),
		classifyNegativacao(input.negativacao),
	]

	if (input.negativacao === 'sim') {
		return {
			approved: false,
			rejectionReason: 'Nome negativado — não emprestamos.',
			score: 0,
			limitBRL: 0,
			interestPct: MAX_INTEREST,
			installments: 1,
			approvedAmountBRL: 0,
		}
	}

	const points = breakdown.reduce((acc, r) => acc + POINTS_PER[r], 0)
	const score = Math.round((points / MAX_POINTS) * 1000)

	const baseRatio = input.negativacao === 'nao' ? 0.1 : 0.05
	const limitBRL = creditLineFor(input.repaid_loans_count, cfg)

	if (input.amount_brl > limitBRL && !cfg.demoRelaxLimit) {
		return {
			approved: false,
			rejectionReason: 'Valor excede o limite disponível.',
			score,
			limitBRL,
			interestPct: MAX_INTEREST,
			installments: installmentsFor(input.amount_brl),
			approvedAmountBRL: 0,
		}
	}

	const scoreFactor = (1 - score / 1000) * (MAX_INTEREST - BASE_INTEREST)
	const ratio = limitBRL > 0 ? input.amount_brl / input.faturamento_mensal_brl : 0
	const ratioFactor = Math.min(ratio / baseRatio, 1) * 0.005
	const interestPct = Math.min(BASE_INTEREST + scoreFactor + ratioFactor, MAX_INTEREST)

	return {
		approved: true,
		rejectionReason: null,
		score,
		limitBRL,
		interestPct,
		installments: installmentsFor(input.amount_brl),
		approvedAmountBRL: Math.min(input.amount_brl, cfg.moneyCapBRL),
	}
}

const REPORT_ABI = [
	{ type: 'bytes32', name: 'cpfHash' },
	{ type: 'bytes32', name: 'borrowerSol32' },
	{ type: 'uint16', name: 'score' },
	{ type: 'bool', name: 'approved' },
	{ type: 'uint64', name: 'amount' },
	{ type: 'bytes32', name: 'loanDecisionPda32' },
	{ type: 'uint64', name: 'writableBitmap' },
] as const

const onHTTPTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	runtime.log('CRE workflow triggered (AltPay score → writeReport)')
	if (!payload.input || payload.input.length === 0) {
		throw new Error('HTTP trigger payload is required')
	}
	const input = inputSchema.parse(JSON.parse(new TextDecoder().decode(payload.input)))
	const cfg = runtime.config

	const decision = computeScoreV5(input, cfg)
	const amountMicroUsdc = BigInt(
		Math.round((decision.approvedAmountBRL * 1_000_000) / cfg.brlPerUsdc),
	)
	const approvedOnChain = decision.approved && decision.score >= cfg.scoreThreshold

	runtime.log(
		`Decision | approved=${approvedOnChain} score=${decision.score} amountMicroUSDC=${amountMicroUsdc} reason=${decision.rejectionReason ?? 'ok'}`,
	)

	const encoded = encodeAbiParameters(REPORT_ABI, [
		input.cpfHash as Hex,
		input.borrowerSol32 as Hex,
		decision.score,
		approvedOnChain,
		amountMicroUsdc,
		input.loanDecisionPda32 as Hex,
		BigInt(cfg.writableBitmap),
	])

	const report = runtime
		.report({
			encodedPayload: hexToBase64(encoded),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	const selector = EVMClient.SUPPORTED_CHAIN_SELECTORS[
		cfg.chainSelectorName as keyof typeof EVMClient.SUPPORTED_CHAIN_SELECTORS
	]
	if (!selector) throw new Error(`unknown chain selector: ${cfg.chainSelectorName}`)

	const evm = new EVMClient(selector)
	const reply = evm
		.writeReport(runtime, {
			receiver: cfg.consumerAddress,
			report,
			gasConfig: { gasLimit: cfg.gasLimit },
		})
		.result()

	const txHashHex = reply.txHash
		? `0x${Buffer.from(reply.txHash).toString('hex')}`
		: '(none)'
	runtime.log(
		`writeReport | txStatus=${reply.txStatus} txHash=${txHashHex} recvStatus=${reply.receiverContractExecutionStatus ?? 'n/a'} err=${reply.errorMessage ?? ''}`,
	)

	return JSON.stringify({
		approved: approvedOnChain,
		score: decision.score,
		amountMicroUsdc: amountMicroUsdc.toString(),
		interestPct: decision.interestPct,
		installments: decision.installments,
		limitBRL: decision.limitBRL,
		rejectionReason: decision.rejectionReason,
		txHash: txHashHex,
	})
}

const initWorkflow = (_config: Config) => {
	const httpTrigger = new cre.capabilities.HTTPCapability()
	return [cre.handler(httpTrigger.trigger({}), onHTTPTrigger)]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}

main()
