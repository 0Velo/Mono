/**
 * Seed-phrase text helpers with no crypto dependency.
 *
 * The onboarding screen renders words as you type, so these stay in the tiny
 * always-loaded entry chunk. Everything that needs a wordlist checksum or a
 * keypair lives in `lib/wallet.ts`, which is imported on demand.
 */

export function normalizeMnemonic(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
}

export function mnemonicWords(input: string): string[] {
  const normalized = normalizeMnemonic(input)
  return normalized ? normalized.split(' ') : []
}

/** Cheap shape check that needs no wordlist (12 or 24 words). */
export function hasMnemonicShape(input: string): boolean {
  const count = mnemonicWords(input).length
  return count === 12 || count === 24
}

/** Rough Base58 private-key shape, used for instant button feedback. */
export function looksLikeSecretKey(input: string): boolean {
  const value = input.trim()
  return value.length >= 80 && value.length <= 100 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
}
