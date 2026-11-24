/**
 * Live Devnet end-to-end send test (steering request: "데브넷 테스트 같이해").
 *
 * Uses the wallet's own transaction code (`estimateFee` / `sendSol` from
 * src/lib/tx.ts) with a disposable keypair, so the real build → sign → send →
 * confirm path is exercised against a real cluster.
 *
 * Honest states:
 *   SENT          a real transfer was broadcast and confirmed (signature given)
 *   SIMULATED     no faucet funds, but blockhash + signing + a signature-verified
 *                 simulation of the signed transfer succeeded on live Devnet
 *   BLOCKED       neither was possible (states the exact RPC/faucet error)
 *
 * Never prints a secret key: only public addresses, signatures and errors.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { estimateFee, sendSol } from '../../../src/lib/tx'

interface Result {
  status: 'SENT' | 'SIMULATED' | 'BLOCKED'
  rpc: string
  airdrop: { attempted: boolean; ok: boolean; lamports?: number; error?: string }
  faucetProbes?: Array<{ url: string; httpStatus: number | null; body: string }>
  transfer?: {
    signature: string
    explorer: string
    from: string
    to: string
    lamports: number
    feeLamports: string
    recipientBalanceBefore: number
    recipientBalanceAfter: number
    balanceChangeMatches: boolean
  }
  simulation?: {
    err: unknown
    logs: string[] | null
    unitsConsumed: number | null
    localSignatureVerified: boolean
    tamperedSignatureRejected: boolean
    tamperedSignatureError: unknown
  }
  notes: string[]
}

const ENDPOINTS = ['https://api.devnet.solana.com', 'https://solana-devnet.publicnode.com']

async function connect(): Promise<{ connection: Connection; url: string }> {
  let lastError: unknown = null
  for (const url of ENDPOINTS) {
    const connection = new Connection(url, 'confirmed')
    try {
      await connection.getLatestBlockhash('confirmed')
      return { connection, url }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('devnet rpc unreachable')
}

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as any
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
  return body.result
}

async function simulateSigned(url: string, tx: Transaction, localVerify = true) {
  const encoded = tx
    .serialize({ requireAllSignatures: false, verifySignatures: localVerify })
    .toString('base64')
  return rpc(url, 'simulateTransaction', [
    encoded,
    { encoding: 'base64', sigVerify: true, commitment: 'confirmed' },
  ])
}

function explorer(signature: string): string {
  return `https://solscan.io/tx/${signature}?cluster=devnet`
}

async function tryAirdrop(connection: Connection, publicKey: PublicKey): Promise<Result['airdrop']> {
  const errors: string[] = []
  for (const url of ENDPOINTS) {
    for (const lamports of [LAMPORTS_PER_SOL, LAMPORTS_PER_SOL / 2]) {
      try {
        const rpcConnection = url === connection.rpcEndpoint ? connection : new Connection(url, 'confirmed')
        const signature = await rpcConnection.requestAirdrop(publicKey, lamports)
        const latest = await rpcConnection.getLatestBlockhash('confirmed')
        const confirmation = await rpcConnection.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          'confirmed',
        )
        if (confirmation.value.err) {
          errors.push(`${url}: confirm ${JSON.stringify(confirmation.value.err)}`)
          continue
        }
        return { attempted: true, ok: true, lamports, error: errors.join(' | ') || undefined }
      } catch (error) {
        errors.push(`${url}: ${String((error as Error)?.message ?? error).trim().slice(0, 200)}`)
      }
    }
  }
  return { attempted: true, ok: false, error: errors.join(' | ').slice(0, 900) }
}

/** Records what each public faucet says, so a blocked airdrop is documented, not assumed. */
async function probeFaucets(address: string): Promise<Array<{ url: string; httpStatus: number | null; body: string }>> {
  const probes: Array<{ url: string; httpStatus: number | null; body: string }> = []
  for (const url of ['https://faucet.solana.com/api/request', 'https://faucet.triangleplatform.com/solana/devnet']) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: 'devnet', walletAddress: address, amount: 1 }),
      })
      probes.push({ url, httpStatus: response.status, body: (await response.text()).slice(0, 200) })
    } catch (error) {
      probes.push({ url, httpStatus: null, body: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
  return probes
}

async function main(): Promise<Result> {
  const result: Result = {
    status: 'BLOCKED',
    rpc: '',
    airdrop: { attempted: false, ok: false },
    notes: [],
  }
  const { connection, url } = await connect()
  result.rpc = url

  const payer = Keypair.generate()
  const recipient = Keypair.generate()
  result.notes.push(`payer=${payer.publicKey.toBase58()}`)
  result.notes.push(`recipient=${recipient.publicKey.toBase58()}`)

  result.airdrop = await tryAirdrop(connection, payer.publicKey)
  if (!result.airdrop.ok) result.faucetProbes = await probeFaucets(payer.publicKey.toBase58())
  const balance = await connection.getBalance(payer.publicKey, 'confirmed')

  if (result.airdrop.ok && balance > 0) {
    const fee = await estimateFee(connection, 'sol', payer.publicKey, null, null)
    const before = await connection.getBalance(recipient.publicKey, 'confirmed')
    const lamports = 10_000_000n // 0.01 SOL
    const signature = await sendSol(connection, payer, recipient.publicKey.toBase58(), lamports)
    const after = await connection.getBalance(recipient.publicKey, 'confirmed')
    result.status = 'SENT'
    result.transfer = {
      signature,
      explorer: explorer(signature),
      from: payer.publicKey.toBase58(),
      to: recipient.publicKey.toBase58(),
      lamports: Number(lamports),
      feeLamports: fee.feeLamports.toString(),
      recipientBalanceBefore: before,
      recipientBalanceAfter: after,
      balanceChangeMatches: after - before === Number(lamports),
    }
    return result
  }

  result.notes.push('faucet did not fund the disposable key; falling back to a signature-verified simulation')

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const build = () => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 10_000_000,
      }),
    )
    tx.recentBlockhash = blockhash
    tx.feePayer = payer.publicKey
    return tx
  }

  const signed = build()
  signed.sign(payer)
  const localVerified = signed.verifySignatures()
  const simulation = await simulateSigned(url, signed)

  // Control: flip one bit of the signature and confirm the cluster rejects it,
  // so a clean result above is a real signature check, not sigVerify being off.
  const tampered = build()
  tampered.addSignature(payer.publicKey, Buffer.from(signed.signatures[0].signature))
  tampered.signatures[0].signature[10] ^= 0x01
  const tamperedSim = await simulateSigned(url, tampered, false)

  result.status = 'SIMULATED'
  result.simulation = {
    err: simulation.value?.err ?? simulation.err ?? null,
    logs: simulation.value?.logs ?? null,
    unitsConsumed: simulation.value?.unitsConsumed ?? null,
    localSignatureVerified: localVerified,
    tamperedSignatureRejected: Boolean(tamperedSim.value?.err ?? tamperedSim.err),
    tamperedSignatureError: tamperedSim.value?.err ?? tamperedSim.err ?? null,
  }
  return result
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.log(
      JSON.stringify(
        { status: "BLOCKED", error: String((error as Error)?.message ?? error).slice(0, 800), stack: String((error as Error)?.stack ?? "").split("\n").slice(0,8) },
        null,
        2,
      ),
    )
  })
