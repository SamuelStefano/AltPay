// DR-003 D7: Anchor signer server-side (raw tx, sem IDL).
// Lightweight version: SEM @solana/spl-token (ATA derivada manualmente) +
// `?target=denonext` no esm.sh pra reduzir parse no isolate Edge.
//
// Motivo: estoura WORKER_RESOURCE_LIMIT do isolate Supabase Edge se carregar
// @solana/spl-token completo (Token-2022 + extensions pesam ~300KB extras).
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from 'https://esm.sh/@solana/web3.js@1.95.3?target=denonext'

// Re-export pra edges consumirem PublicKey via anchor-signer (1 fetch a menos)
export { PublicKey } from 'https://esm.sh/@solana/web3.js@1.95.3?target=denonext'

const PROGRAM_ID = new PublicKey(Deno.env.get('PROGRAM_ID') ?? '6m2ipcrUCRpSqkPSqNNKNH11rNmVsu8KmnBLnBtFsq2N')
const USDC_MINT = new PublicKey(Deno.env.get('USDC_MINT_DEVNET') ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const RPC_URL = Deno.env.get('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com'

// Constantes do SPL Token program (substituem @solana/spl-token)
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

const LOAN_SEED = new TextEncoder().encode('loan')
const VAULT_SEED = new TextEncoder().encode('vault')

export async function methodDiscriminator(name: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${name}`))
  return new Uint8Array(buf).slice(0, 8)
}

export function loadAdminKeypair(): Keypair {
  const raw = Deno.env.get('SOLANA_ADMIN_KEYPAIR_JSON')
  if (!raw) throw new Error('SOLANA_ADMIN_KEYPAIR_JSON env missing')
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
}

export function connection(): Connection {
  return new Connection(RPC_URL, 'confirmed')
}

export function deriveLoanPda(cpfHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([LOAN_SEED, cpfHash], PROGRAM_ID)
}

export function deriveVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID)
}

// ATA derivation manual — substitui getAssociatedTokenAddress do spl-token.
// Seeds: [owner, TOKEN_PROGRAM_ID, mint] under ASSOCIATED_TOKEN_PROGRAM_ID.
function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata
}

// Idempotent ATA create instruction — substitui createAssociatedTokenAccountIdempotentInstruction.
// Discriminator do instruction: byte 0x01 (Idempotent vs 0x00 que é throw-if-exists).
function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]), // 0x01 = CreateIdempotent
  })
}

function u64ToBytesLE(n: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, n, true)
  return buf
}

function u16ToBytesLE(n: number): Uint8Array {
  const buf = new Uint8Array(2)
  new DataView(buf.buffer).setUint16(0, n, true)
  return buf
}

interface VaultState {
  authority: PublicKey
  usdcMint: PublicKey
  tokenAccount: PublicKey
  totalReleased: bigint
  bump: number
}

async function fetchVaultState(conn: Connection, vault: PublicKey): Promise<VaultState> {
  const acc = await conn.getAccountInfo(vault)
  if (!acc) throw new Error(`Vault account not found at ${vault.toBase58()}`)
  const data = acc.data.slice(8)
  return {
    authority: new PublicKey(data.slice(0, 32)),
    usdcMint: new PublicKey(data.slice(32, 64)),
    tokenAccount: new PublicKey(data.slice(64, 96)),
    totalReleased: new DataView(data.buffer, data.byteOffset + 96, 8).getBigUint64(0, true),
    bump: data[104],
  }
}

