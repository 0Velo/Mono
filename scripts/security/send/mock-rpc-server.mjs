/**
 * Local stand-in for the Devnet JSON-RPC, used only by the browser test.
 *
 * It answers the handful of methods Mono's send flow calls, with the same
 * arithmetic the real cluster would produce for a 1 SOL wallet transferring
 * `amount` lamports. MODE decides how confirmation behaves:
 *
 *   confirm  the signature is reported confirmed (normal path)
 *   stall    getSignatureStatuses returns null and the block height never
 *            advances, so the wallet must time out on its own
 *   error    every status read fails with a JSON-RPC error
 *   fail     the signature is confirmed with an on-chain error
 *
 * Nothing here holds a key or talks to the network.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { PublicKey, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'

const MODE = process.env.MODE || 'confirm'
const PORT = Number(process.env.PORT || 8899)
const SLOT = 4242
const HEIGHT = 1_000
const BLOCKHASH = bs58.encode(crypto.createHash('sha256').update(`mono-mock-${MODE}`).digest())
const LAMPORTS_PER_SOL = 1_000_000_000
const FEE = 5_000

const log = (...args) => process.stdout.write(`[mock:${MODE}] ${args.join(' ')}\n`)

let requestCount = 0
let sentSignature = null

function systemAccount(address, lamports) {
  return {
    executable: false,
    owner: SystemProgram.programId.toBase58(),
    lamports,
    data: ['', 'base64'],
    rentEpoch: 0,
  }
}

function transferLamports(tx) {
  try {
    const message = TransactionMessage.decompile(tx.message)
    const instruction = message.instructions.find((item) => item.programId.equals(SystemProgram.programId))
    if (!instruction) return 0n
    return SystemInstruction.decodeTransfer(instruction).lamports
  } catch (error) {
    log('decode failed', String(error))
    return 0n
  }
}

function handle(method, params) {
  requestCount += 1
  switch (method) {
    case 'getHealth':
      return 'ok'
    case 'getVersion':
      return { 'solana-core': '1.18.26', 'feature-set': 0 }
    case 'getGenesisHash':
      return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    case 'getLatestBlockhash':
      return { context: { slot: SLOT }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: HEIGHT + 150 } }
    case 'getBlockHeight':
    case 'getSlot':
      return HEIGHT
    case 'getEpochInfo':
      return { absoluteSlot: SLOT, blockHeight: HEIGHT, epoch: 1, slotIndex: 0, slotsInEpoch: 432000 }
    case 'getBalance':
      return { context: { slot: SLOT }, value: LAMPORTS_PER_SOL }
    case 'getAccountInfo':
      return { context: { slot: SLOT }, value: null }
    case 'getMultipleAccounts':
      return {
        context: { slot: SLOT },
        value: (params?.[0] ?? []).map((address) => (address === params?.[0]?.[0] ? systemAccount(address, LAMPORTS_PER_SOL) : null)),
      }
    case 'getParsedTokenAccountsByOwner':
    case 'getTokenAccountsByOwner':
      return { context: { slot: SLOT }, value: [] }
    case 'getFeeForMessage':
      return { context: { slot: SLOT }, value: FEE }
    case 'getFeeCalculatorForBlockhash':
      return { context: { slot: SLOT }, value: { feeCalculator: { lamportsPerSignature: FEE } } }
    case 'getSignaturesForAddress':
      return []
    case 'getParsedTransaction':
    case 'getTransaction':
      return null
    case 'simulateTransaction': {
      const encoded = params?.[0]
      const config = params?.[1] ?? {}
      const addresses = config.accounts?.addresses ?? []
      const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'))
      const amount = Number(transferLamports(tx))
      const owner = addresses[0]
      const recipient = addresses[1]
      const accounts = addresses.map((address, index) => {
        if (index === 0) return systemAccount(address, LAMPORTS_PER_SOL - amount - FEE)
        if (address === recipient) return systemAccount(address, amount)
        return null
      })
      return {
        context: { slot: SLOT },
        value: {
          err: null,
          accounts,
          logs: [
            `Program ${SystemProgram.programId.toBase58()} invoke [1]`,
            'Program log: Instruction: Transfer',
            `Program ${SystemProgram.programId.toBase58()} success`,
          ],
          unitsConsumed: 150,
          returnData: null,
          innerInstructions: [],
        },
      }
    }
    case 'sendTransaction':
    case 'sendRawTransaction': {
      const tx = VersionedTransaction.deserialize(Buffer.from(params?.[0], 'base64'))
      sentSignature = bs58.encode(tx.signatures[0])
      log('broadcast', sentSignature.slice(0, 8))
      return sentSignature
    }
    case 'getSignatureStatuses': {
      const signatures = params?.[0] ?? []
      if (MODE === 'error') {
        const error = new Error('mock status failure')
        error.rpcError = { code: -32005, message: 'Node is behind by 100 slots' }
        throw error
      }
      if (MODE === 'stall') return { context: { slot: SLOT }, value: signatures.map(() => null) }
      if (MODE === 'fail') {
        return {
          context: { slot: SLOT },
          value: signatures.map((signature) => ({
            slot: SLOT,
            confirmations: 1,
            err: { InstructionError: [0, 'Custom'] },
            confirmationStatus: 'confirmed',
            status: { Err: { InstructionError: [0, 'Custom'] } },
          })),
        }
      }
      return {
        context: { slot: SLOT },
        value: signatures.map((signature) => ({
          slot: SLOT,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed',
          status: { Ok: null },
        })),
      }
    }
    case 'getMinimumBalanceForRentExemption':
      return 2_039_280
    default:
      log('unhandled method', method)
      return null
  }
}

const server = http.createServer((request, response) => {
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'content-type': 'application/json',
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers)
    response.end()
    return
  }
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      response.writeHead(400, headers)
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }))
      return
    }
    const batch = Array.isArray(payload) ? payload : [payload]
    const replies = batch.map((item) => {
      try {
        return { jsonrpc: '2.0', id: item.id ?? null, result: handle(item.method, item.params) }
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id: item.id ?? null,
          error: error?.rpcError ?? { code: -32000, message: String(error?.message ?? error) },
        }
      }
    })
    response.writeHead(200, headers)
    response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]))
  })
})

server.listen(PORT, '127.0.0.1', () => log(`listening on ${PORT}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
