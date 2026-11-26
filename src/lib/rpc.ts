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

/**
 * The network name an exchange's withdraw screen shows. "Solana Mainnet" is a
 * developer's label; on a withdrawal form the same chain is listed as
 * `Solana (SOL)` — next to ERC20/BEP20 choices, which this address cannot take.
 * Devnet keeps its own name because it is a different, test-only chain.
 */
export const NETWORK_DISPLAY_NAME: Record<NetworkId, string> = {
  mainnet: 'Solana (SOL · SPL)',
  devnet: 'Solana Devnet',
}

export function networkDisplayName(network: NetworkId): string {
  return NETWORK_DISPLAY_NAME[network] ?? NETWORK_DISPLAY_NAME.mainnet
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

/**
 * Endpoints a stored custom RPC may use. https everywhere; plain http only for
 * a loopback address, so a local `solana-test-validator` still works while a
 * remote http endpoint (readable and rewritable by anyone on the path) cannot
 * be configured or smuggled in through a stale stored value.
 */
function isAllowedRpcUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

export function rpcUrlFor(network: NetworkId, custom?: string | null): string {
  const trimmed = (custom ?? '').trim()
  if (!trimmed) return DEFAULT_RPC[network]
  try {
    const url = new URL(trimmed)
    // A stored value written by an older build (or by hand) must not be able
    // to downgrade the connection to plaintext.
    return isAllowedRpcUrl(url) ? trimmed : DEFAULT_RPC[network]
  } catch {
    return DEFAULT_RPC[network]
  }
}

export function rpcHostLabel(network: NetworkId, custom?: string | null): string {
  try {
    const url = new URL(rpcUrlFor(network, custom))
    return url.host
  } catch {
    return NETWORK_LABEL[network]
  }
}

/** True when the input is a usable RPC endpoint (https, or http on loopback). */
export function looksLikeRpc(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    return isAllowedRpcUrl(new URL(trimmed))
  } catch {
    return false
  }
}
