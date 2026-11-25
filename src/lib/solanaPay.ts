/**
 * Solana Pay request parsing — the text a QR code (or a pasted message) can
 * carry into the send sheet.
 *
 * A transfer request is a `solana:` URI:
 *
 *   solana:<address>?amount=<decimal>&spl-token=<mint>&memo=<text>&label=…&message=…&reference=…
 *
 * Everything here is a pure string→value step, so the address field can accept
 * both a bare address and a full request, and a scanned QR can be judged before
 * any of it reaches the transaction. Nothing in this module trusts its input:
 * the address must decode to a real 32-byte public key, the amount must be a
 * plain positive decimal (no sign, no exponent, no whitespace), and the memo is
 * reduced to printable text of a bounded length.
 *
 * Parsing never fills in a value it could not verify. A request whose amount is
 * malformed is rejected as a whole; sending the right address with the wrong
 * amount is exactly the mistake this screen exists to prevent.
 */
import bs58 from 'bs58'

/** Solana Memo Program v2 — only data, no accounts, no key material. */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

/** Memo bytes allowed in one transaction; a URI memo is UI text, so cap it short. */
export const MAX_MEMO_LENGTH = 100

/** A longer string is not a payment request; refuse before doing any work. */
const MAX_INPUT_LENGTH = 2048

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/

/** True only for a Base58 string that decodes to exactly 32 bytes. */
export function isSolanaAddress(value: string): boolean {
  const text = value.trim()
  if (text.length < 32 || text.length > 44) return false
  if (!BASE58.test(text)) return false
  try {
    return bs58.decode(text).length === 32
  } catch {
    return false
  }
}

/**
 * A transfer amount as the URI carries it: a positive decimal with no sign,
 * no exponent and no grouping. `1.` and `.5` are refused rather than guessed.
 */
export function normalizeAmount(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || !AMOUNT.test(text)) return null
  if (text === '0' || /^0\.0*$/.test(text)) return null
  return text
}

/**
 * Printable single-line memo text. Control characters, line breaks and
 * zero-width marks are dropped so a scanned code cannot restyle the sheet, and
 * the result is capped to a length the Memo program accepts comfortably.
 */
export function sanitizeMemo(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, MAX_MEMO_LENGTH).join('').trim()
}

export interface SolanaPayRequest {
  address: string
  amount: string | null
  splToken: string | null
  memo: string | null
  label: string | null
  message: string | null
  reference: string | null
}

export type SolanaPayParse =
  | { ok: true; request: SolanaPayRequest }
  | { ok: false; reason: 'not-request' | 'invalid-address' | 'invalid-amount' | 'invalid-token' }

export type ParsedRecipient =
  | {
      ok: true
      address: string
      amount: string | null
      splToken: string | null
      memo: string | null
      /** True when the text was a `solana:` request rather than a bare address. */
      fromUri: boolean
    }
  | { ok: false; reason: 'invalid-address' | 'invalid-amount' | 'invalid-token' }

function readParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Parses `solana:` transfer requests and says why a request was refused, so the
 * sheet can tell "this is a link, not a Solana address" apart from "this request
 * asks for an amount that cannot be sent". Nothing here throws.
 */
export function parseSolanaPayDetailed(input: string): SolanaPayParse {
  const text = input.trim()
  if (!text || text.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'not-request' }
  const match = /^solana:([^?#\s]*)(?:\?([^#\s]*))?(?:#\S*)?$/i.exec(text)
  if (!match) return { ok: false, reason: 'not-request' }
  const address = decodeURIComponentSafe(match[1] ?? '')
  if (!isSolanaAddress(address)) return { ok: false, reason: 'invalid-address' }
  const params = new URLSearchParams(match[2] ?? '')
  const rawAmount = readParam(params, 'amount')
  const amount = normalizeAmount(rawAmount)
  // A present but unreadable amount is refused, never silently dropped.
  if (rawAmount !== null && amount === null) return { ok: false, reason: 'invalid-amount' }
  const splToken = readParam(params, 'spl-token')
  if (splToken !== null && !isSolanaAddress(splToken)) return { ok: false, reason: 'invalid-token' }
  const memo = sanitizeMemo(readParam(params, 'memo'))
  return {
    ok: true,
    request: {
      address,
      amount,
      splToken,
      memo: memo || null,
      label: readParam(params, 'label'),
      message: readParam(params, 'message'),
      reference: readParam(params, 'reference'),
    },
  }
}

export function parseSolanaPay(input: string): SolanaPayRequest | null {
  const parsed = parseSolanaPayDetailed(input)
  return parsed.ok ? parsed.request : null
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * What the send sheet should do with text someone typed, pasted or scanned:
 * fill the address, and when present the amount, token and memo, in one step.
 */
export function parseRecipientInput(input: string): ParsedRecipient {
  const text = input.trim()
  if (!text) return { ok: false, reason: 'invalid-address' }
  if (/^solana:/i.test(text)) {
    const parsed = parseSolanaPayDetailed(text)
    if (!parsed.ok) {
      // A URI that is not a payment request at all is "not an address"; one
      // that is but carries unusable values keeps its specific reason.
      return {
        ok: false,
        reason: parsed.reason === 'not-request' ? 'invalid-address' : parsed.reason,
      }
    }
    const request = parsed.request
    return {
      ok: true,
      address: request.address,
      amount: request.amount,
      splToken: request.splToken,
      memo: request.memo,
      fromUri: true,
    }
  }
  if (!isSolanaAddress(text)) return { ok: false, reason: 'invalid-address' }
  return { ok: true, address: text, amount: null, splToken: null, memo: null, fromUri: false }
}
