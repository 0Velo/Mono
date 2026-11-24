/**
 * Derivation paths, kept in a module with no cryptography so the onboarding
 * screen (which must stay in the first-paint chunk) can name the standard path
 * without pulling in bip39/web3.js.
 *
 * Phantom, Solflare and Backpack all derive the first Solana account from a
 * seed phrase at `m/44'/501'/0'/0'`. Any other path produces a different
 * address for the same 12/24 words, which looks exactly like "my funds are
 * missing" to the person importing. This constant is the single source of
 * truth so no screen can invent a variant again.
 */

export const DEFAULT_DERIVATION_PATH = "m/44'/501'/0'/0'"

/** Phantom-style additional accounts: m/44'/501'/index'/0'. */
export function accountPath(index: number): string {
  return `m/44'/501'/${Math.max(0, Math.trunc(index))}'/0'`
}

const SEGMENT = /^\d+['hH]$/

/** True when every segment is hardened, as SLIP-0010 ed25519 requires. */
export function isHardenedPath(path: string): boolean {
  const body = path.trim().replace(/^m\/?/, '')
  if (!body) return false
  return body.split('/').every((segment) => SEGMENT.test(segment))
}

/**
 * Repairs a stored payload whose path is not the standard hardened path
 * (vaults and backups written before the onboarding import path was fixed).
 * Secret-key payloads ignore the path, but they are normalised too so every
 * record in the app agrees on one value.
 */
export function normalizePayloadPath<T extends { path?: string }>(payload: T): T {
  const path = typeof payload.path === 'string' ? payload.path : ''
  if (isHardenedPath(path)) return path === DEFAULT_DERIVATION_PATH ? payload : { ...payload, path: path.trim() }
  return { ...payload, path: DEFAULT_DERIVATION_PATH }
}
