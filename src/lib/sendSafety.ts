/**
 * The two things a person needs to see before a transfer leaves: who the
 * address actually is, and what is left in SOL afterwards.
 *
 * The wallet already blocks an unaffordable send; this is the other mistake —
 * a send that goes through, to the wrong copy-pasted address, or that empties
 * the wallet down to something the account can no longer hold. Both answers are
 * one line each, computed from what is on screen, with no extra network calls.
 */
import type { WalletAccount } from '../state/WalletProvider'
import type { AddressEntry } from './addressBook'

/** An account below this cannot stay rent-exempt; it is the "0에 가까움" line. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n

export type RecipientKind = 'self' | 'own' | 'book' | 'external'

export interface RecipientBadge {
  kind: RecipientKind
  label: string
  /** True for anything the person has not sent to from this device before. */
  caution: boolean
}

export interface RecipientContext {
  owner: string
  accounts: readonly Pick<WalletAccount, 'index' | 'address' | 'name'>[]
  book: readonly Pick<AddressEntry, 'label' | 'address'>[]
}

/**
 * Names an address in the smallest possible number of characters:
 * `내 계정 2`, the address-book label (`업비트`), or the caution chip
 * `처음 보내는 주소`. Returns null for text that is not an address yet.
 */
export function describeRecipient(
  address: string,
  context: RecipientContext,
): RecipientBadge | null {
  const value = address.trim()
  if (!value) return null
  if (context.owner && value === context.owner) {
    return { kind: 'self', label: '현재 계정', caution: true }
  }
  const own = context.accounts.find((account) => account.address === value)
  if (own) {
    const named = own.name && !/^계정 \d+$/.test(own.name) && own.name !== '메인'
    return {
      kind: 'own',
      label: named ? `내 계정 · ${own.name}` : `내 계정 ${own.index + 1}`,
      caution: false,
    }
  }
  const entry = context.book.find((item) => item.address === value)
  if (entry) return { kind: 'book', label: entry.label, caution: false }
  return { kind: 'external', label: '처음 보내는 주소', caution: true }
}

export interface RemainingSolInput {
  kind: 'sol' | 'spl'
  /** Base units of the asset being sent (0 when nothing is typed yet). */
  amount: bigint
  solBalance: bigint
  feeLamports: bigint
  rentLamports: bigint
}

/**
 * SOL left in the wallet after this exact transfer: the amount, the network
 * fee, and any token account rent the recipient needs are all subtracted.
 * Negative means it cannot be paid — the send button is already disabled then.
 */
export function remainingSolAfterSend(input: RemainingSolInput): bigint {
  const spent = input.feeLamports + input.rentLamports + (input.kind === 'sol' ? input.amount : 0n)
  return input.solBalance - spent
}

/** One short caution when the leftover cannot keep the account rent-exempt. */
export function remainingSolWarning(remaining: bigint): string | null {
  if (remaining < 0n) return '수수료까지 넣으면 SOL이 모자랍니다'
  if (remaining < RENT_EXEMPT_MIN_LAMPORTS) return '0에 가까워요 · 계정 유지 최소 0.00089 SOL'
  return null
}
