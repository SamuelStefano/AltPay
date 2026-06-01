const P = (1n << 255n) - 19n

function mod(a: bigint): bigint {
  const r = a % P
  return r >= 0n ? r : r + P
}

function powMod(base: bigint, exp: bigint): bigint {
  let result = 1n
  let b = mod(base)
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = mod(result * b)
    b = mod(b * b)
    e >>= 1n
  }
  return result
}

function inv(a: bigint): bigint {
  return powMod(a, P - 2n)
}

const D = mod(-121665n * inv(121666n))

function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i])
  y = y & ((1n << 255n) - 1n)
  if (y >= P) return false

  const y2 = mod(y * y)
  const u = mod(y2 - 1n)
  const v = mod(D * y2 + 1n)
  const x2 = mod(u * inv(v))
  if (x2 === 0n) return true

  const x0 = powMod(x2, (P + 3n) / 8n)
  if (mod(x0 * x0) === x2) return true
  if (mod(x0 * x0) === mod(-x2)) return true
  return false
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')

async function sha256(buf: Uint8Array): Promise<Uint8Array> {
  const h = await crypto.subtle.digest('SHA-256', buf)
  return new Uint8Array(h)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): Promise<{ pubkey: Uint8Array; bump: number }> {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = await sha256(concat([...seeds, new Uint8Array([bump]), programId, PDA_MARKER]))
    if (!isOnCurve(hash)) return { pubkey: hash, bump }
  }
  throw new Error('unable to find a viable PDA bump')
}
