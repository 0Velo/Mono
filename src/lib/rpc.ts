import { Connection } from '@solana/web3.js'

export type NetworkId = 'mainnet' | 'devnet'

export const DEFAULT_RPC: Record<NetworkId, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
}

/**
 * The official public endpoints reject cross-origin browser calls (the
 * mainnet one answers 403 to any request carrying an Origin header), so every
 * defaulted connection retries on a CORS-friendly mirror before failing.
 */
const PUBLIC_MIRRORS: Record<NetworkId, string[]> = {
  mainnet: [
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
    'https://solana.drpc.org',
  ],
  devnet: ['https://api.devnet.solana.com'],
}

export const NETWORK_LABEL: Record<NetworkId, string> = {
  mainnet: 'Mainnet',
  devnet: 'Devnet',
}

const EXPLORER = 'https://solscan.io'

export function explorerTx(signature: string, network: NetworkId): string {
  return `${EXPLORER}/tx/${signature}${network === 'devnet' ? '?cluster=devnet' : ''}`
}

export function explorerAddress(address: string, network: NetworkId): string {
  return `${EXPLORER}/account/${address}${network === 'devnet' ? '?cluster=devnet' : ''}`
}

export function rpcUrlFor(network: NetworkId, custom?: string | null): string {
  const trimmed = (custom ?? '').trim()
  return trimmed || DEFAULT_RPC[network]
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

export function rpcHostLabel(network: NetworkId, custom?: string | null): string {
  try {
    const url = new URL(rpcUrlFor(network, custom))
    return url.host
  } catch {
    return NETWORK_LABEL[network]
  }
}
