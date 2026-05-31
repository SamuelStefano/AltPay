import {
	cre,
	EVMClient,
	type HTTPPayload,
	Runner,
	type Runtime,
} from '@chainlink/cre-sdk'
import { encodeAbiParameters, type Hex } from 'viem'
import { z } from 'zod'

// hex → base64 (proto JSON encodes `bytes` as base64). Mirrors the SDK's
// internal hexToBase64; Buffer is available in the CRE javy runtime.
const hexToBase64 = (hex: Hex): string =>
	Buffer.from(hex.slice(2), 'hex').toString('base64')

const configSchema = z.object({
	chainSelectorName: z.string(),
	consumerAddress: z.string(),
	gasLimit: z.string(),
})

type Config = z.infer<typeof configSchema>

// 7-field report ABI — same tuple the real pipeline will use (DR-010).
// Gate #1 only proves the Mock forwarder calls onReport, so values are dummy.
const REPORT_ABI = [
	{ type: 'bytes32', name: 'cpfHash' },
	{ type: 'bytes32', name: 'borrowerSol32' },
	{ type: 'uint16', name: 'score' },
	{ type: 'bool', name: 'approved' },
	{ type: 'uint64', name: 'amount' },
	{ type: 'bytes32', name: 'loanDecisionPda32' },
	{ type: 'uint64', name: 'writableBitmap' },
] as const

const onHTTPTrigger = (runtime: Runtime<Config>, _payload: HTTPPayload): string => {
	runtime.log('GATE#1 stub workflow triggered')

	const cfg = runtime.config
	const selector = EVMClient.SUPPORTED_CHAIN_SELECTORS[
		cfg.chainSelectorName as keyof typeof EVMClient.SUPPORTED_CHAIN_SELECTORS
	]
	if (!selector) throw new Error(`unknown chain selector: ${cfg.chainSelectorName}`)

	const encoded = encodeAbiParameters(REPORT_ABI, [
		`0x${'11'.repeat(32)}` as Hex,
		`0x${'22'.repeat(32)}` as Hex,
		720,
		true,
		200000n,
		`0x${'33'.repeat(32)}` as Hex,
		0n,
	])

	const report = runtime
		.report({
			encodedPayload: hexToBase64(encoded),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

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
		`GATE#1 writeReport | txStatus=${reply.txStatus} txHash=${txHashHex} recvStatus=${reply.receiverContractExecutionStatus ?? 'n/a'} err=${reply.errorMessage ?? ''}`,
	)
	return JSON.stringify({ ok: true, consumer: cfg.consumerAddress, txHash: txHashHex })
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
