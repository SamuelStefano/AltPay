import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.BRIDGE_PORT ?? 8787)
const SECRET = process.env.BRIDGE_SECRET ?? ''
const CRE_DIR = process.env.CRE_DIR ?? join(import.meta.dir, '..')
const CRE_BIN = process.env.CRE_BIN ?? `${process.env.HOME}/.cre/bin/cre`
const TARGET = process.env.CRE_TARGET ?? 'staging-settings'

type Input = {
	cpfHash: string
	borrowerSol32: string
	loanDecisionPda32: string
	faturamento_mensal_brl: number
	amount_brl: number
	tempo_uber_meses: number
	dias_semana: number
	corridas_semana: number
	fonte_renda: string
	nota_motorista: number
	status_veiculo: string
	negativacao: string
	repaid_loans_count?: number
}

function runSimulate(input: Input): Promise<{ result: unknown; stdout: string }> {
	const dir = mkdtempSync(join(tmpdir(), 'cre-bridge-'))
	const payloadPath = join(dir, 'payload.json')
	writeFileSync(payloadPath, JSON.stringify(input))

	const args = [
		'workflow',
		'simulate',
		'./score-workflow',
		'--target',
		TARGET,
		'--broadcast',
		'--http-payload',
		`@${payloadPath}`,
		'--non-interactive',
		'--trigger-index',
		'0',
		'-e',
		'.env',
	]

	return new Promise((resolve, reject) => {
		const child = spawn(CRE_BIN, args, { cwd: CRE_DIR })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (d) => {
			stdout += d.toString()
		})
		child.stderr.on('data', (d) => {
			stderr += d.toString()
		})
		child.on('error', reject)
		child.on('close', (code) => {
			rmSync(dir, { recursive: true, force: true })
			if (code !== 0) {
				reject(new Error(`cre exited ${code}: ${stderr || stdout}`))
				return
			}
			resolve({ result: parseResult(stdout), stdout })
		})
	})
}

function parseResult(stdout: string): unknown {
	const marker = 'Workflow Simulation Result:'
	const idx = stdout.indexOf(marker)
	if (idx === -1) return null
	const after = stdout.slice(idx + marker.length)
	const start = after.indexOf('"')
	if (start === -1) return null
	let depth = 0
	let end = -1
	for (let i = start; i < after.length; i++) {
		const ch = after[i]
		if (ch === '"' && after[i - 1] !== '\\') depth ^= 1
		if (depth === 0 && ch === '"' && i > start) {
			end = i
			break
		}
	}
	const quoted = after.slice(start, end + 1)
	try {
		return JSON.parse(JSON.parse(quoted) as string)
	} catch {
		return null
	}
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url)
		if (req.method === 'GET' && url.pathname === '/health') {
			return Response.json({ ok: true })
		}
		if (req.method === 'POST' && url.pathname === '/decide') {
			if (!SECRET || req.headers.get('x-bridge-secret') !== SECRET) {
				return Response.json({ error: 'unauthorized' }, { status: 401 })
			}
			let input: Input
			try {
				input = (await req.json()) as Input
			} catch {
				return Response.json({ error: 'invalid json' }, { status: 400 })
			}
			try {
				const { result } = await runSimulate(input)
				return Response.json({ ok: true, decision: result })
			} catch (e) {
				return Response.json(
					{ error: e instanceof Error ? e.message : String(e) },
					{ status: 502 },
				)
			}
		}
		return Response.json({ error: 'not found' }, { status: 404 })
	},
})

console.log(`cre-bridge listening on :${PORT} (cre=${CRE_BIN}, dir=${CRE_DIR}, target=${TARGET})`)
