/**
 * Lazy handle to the key/seed module.
 *
 * `bip39` + `@solana/web3.js` + `@noble/hashes` are ~500 KB together, so no
 * always-loaded screen may import them statically. Anything that needs to
 * generate, validate or derive a key calls `loadKeys()` first; the promise is
 * cached, so the second call is free.
 */

export type KeysModule = typeof import('./wallet')

let pending: Promise<KeysModule> | null = null

export function loadKeys(): Promise<KeysModule> {
  if (!pending) pending = import('./wallet')
  return pending
}

/** Warm the chunk during an idle moment without blocking anything. */
export function prefetchKeys(): void {
  void loadKeys().catch(() => {
    pending = null
  })
}
