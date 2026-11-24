/**
 * The only module that constructs a web3.js `Connection`.
 *
 * It is intentionally *not* imported by the app shell: `Shell` (the screen
 * behind the lock) imports it, and that whole graph is a lazy chunk. Keeping
 * it out of `lib/rpc.ts` is what lets the first paint ship without web3.js.
 */
import { Connection } from '@solana/web3.js'
import { DEFAULT_RPC, rpcUrlFor, type NetworkId } from './rpc'

/**
 * The official public endpoints reject cross-origin browser calls (the
 * mainnet one answers 403 to any request carrying an Origin header), so every
 * defaulted connection retries on a CORS-friendly mirror before failing.
 */
const PUBLIC_MIRRORS: Record<NetworkId, string[]> = {
  mainnet: [
    DEFAULT_RPC.mainnet,
    'https://solana-rpc.publicnode.com',
    'https://solana.drpc.org',
  ],
  devnet: [DEFAULT_RPC.devnet],
}

const RETRY_STATUSES = new Set([403, 429, 500, 502, 503, 521, 522, 524])

export function makeConnection(network: NetworkId, custom?: string | null): Connection {
  const primary = rpcUrlFor(network, custom)
  const isCustom = Boolean((custom ?? '').trim())
  const endpoints = isCustom
    ? [primary]
    : [primary, ...PUBLIC_MIRRORS[network].filter((url) => url !== primary)]

  const resilientFetch: typeof fetch = async (input, init) => {
    let lastResponse: Response | null = null
    let lastError: unknown = null

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, init)
        if (response.ok) return response
        lastResponse = response
        if (!RETRY_STATUSES.has(response.status)) return response
      } catch (error) {
        lastError = error
      }
    }

    if (lastResponse) return lastResponse
    throw lastError instanceof Error ? lastError : new Error('RPC 연결에 실패했습니다')
  }

  return new Connection(primary, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 45_000,
    disableRetryOnRateLimit: false,
    fetch: resilientFetch,
  })
}
