/**
 * Network constants and explorer links.
 *
 * Deliberately free of `@solana/web3.js` so this module can live in the
 * always-loaded app shell: the heavy Connection code is only pulled in by
 * `lib/connection.ts`, which the wallet screen loads after unlock.
 */

export type NetworkId = 'mainnet' | 'devnet'

export const DEFAULT_RPC: Record<NetworkId, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
}

export const NETWORK_LABEL: Record<NetworkId, string> = {
  mainnet: 'Mainnet',
  devnet: 'Devnet',
}

/** Copy-paste example shown in Settings so nobody has to guess the format. */
export const RPC_EXAMPLE: Record<NetworkId, string> = {
  mainnet: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
  devnet: 'https://devnet.helius-rpc.com/?api-key=YOUR_KEY',
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

export function rpcHostLabel(network: NetworkId, custom?: string | null): string {
  try {
    const url = new URL(rpcUrlFor(network, custom))
    return url.host
  } catch {
    return NETWORK_LABEL[network]
  }
}

/** True when the input looks like a usable http(s) RPC endpoint. */
export function looksLikeRpc(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
