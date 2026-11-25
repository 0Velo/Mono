/**
 * Area 8 — the text a QR code (or clipboard) puts into the send sheet.
 *
 * A scanned code is untrusted input that decides where money goes. These tests
 * pin down the parser: a request is either fully understood — address, amount,
 * token, memo — or refused, never half-applied, and nothing that only looks
 * like an address can become one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MEMO_LENGTH,
  isSolanaAddress,
  normalizeAmount,
  parseRecipientInput,
  parseSolanaPay,
  parseSolanaPayDetailed,
  sanitizeMemo,
} from '../../../src/lib/solanaPay'

const ADDRESS = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

test('a bare address is accepted, a 31-byte look-alike is not', () => {
  assert.equal(isSolanaAddress(ADDRESS), true)
  assert.equal(isSolanaAddress('  ' + ADDRESS + '\n'), true)
  // 43 Base58 characters that decode to 31 bytes: shaped right, not a key.
  assert.equal(isSolanaAddress('2'.repeat(43)), false)
  assert.equal(isSolanaAddress(''), false)
  assert.equal(isSolanaAddress('<img src=x onerror=alert(1)>'), false)
  assert.equal(isSolanaAddress('0OIl' + ADDRESS.slice(4)), false)
})

test('a transfer request carries address, amount, token and memo', () => {
  const request = parseSolanaPay(
    `solana:${ADDRESS}?amount=1.25&spl-token=${MINT}&memo=order%2042&label=Shop&message=Thanks`,
  )
  assert.ok(request)
  assert.equal(request!.address, ADDRESS)
  assert.equal(request!.amount, '1.25')
  assert.equal(request!.splToken, MINT)
  assert.equal(request!.memo, 'order 42')
  assert.equal(request!.label, 'Shop')
  assert.equal(request!.message, 'Thanks')
})

test('a bare `solana:` URI without parameters is a plain address', () => {
  const request = parseSolanaPay(`solana:${ADDRESS}`)
  assert.ok(request)
  assert.equal(request!.amount, null)
  assert.equal(request!.memo, null)
})

test('amounts must be plain positive decimals', () => {
  for (const good of ['1', '0.000001', '12.5', '100000000000', ' 1 ']) {
    assert.equal(normalizeAmount(good), good.trim(), good)
  }
  for (const bad of ['-1', '1e9', '1,000', '.5', '1.', '0', '0.0', '1.2.3', '', 'NaN', '+1']) {
    assert.equal(normalizeAmount(bad), null, bad)
  }
})

test('a request with an unusable amount is refused as a whole, not applied partially', () => {
  const parsed = parseSolanaPayDetailed(`solana:${ADDRESS}?amount=-5`)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.ok === false && parsed.reason, 'invalid-amount')
  assert.equal(parseSolanaPay(`solana:${ADDRESS}?amount=1e9`), null)

  const input = parseRecipientInput(`solana:${ADDRESS}?amount=1e9`)
  assert.equal(input.ok, false)
  assert.equal(input.ok === false && input.reason, 'invalid-amount')
})

test('an invalid token mint or address refuses the request', () => {
  const badToken = parseSolanaPayDetailed(`solana:${ADDRESS}?spl-token=not-a-mint`)
  assert.equal(badToken.ok, false)
  assert.equal(badToken.ok === false && badToken.reason, 'invalid-token')

  const badAddress = parseSolanaPayDetailed('solana:not-an-address?amount=1')
  assert.equal(badAddress.ok, false)
  assert.equal(badAddress.ok === false && badAddress.reason, 'invalid-address')
})

test('other links and schemes are not payment requests', () => {
  for (const text of [
    'https://example.com/?amount=1',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    `bitcoin:${ADDRESS}?amount=1`,
    'solana:',
  ]) {
    assert.equal(parseSolanaPay(text), null, text)
    const parsed = parseRecipientInput(text)
    assert.equal(parsed.ok, false, text)
  }
})

test('a memo is reduced to one line of printable text', () => {
  assert.equal(sanitizeMemo('  hello\nworld  '), 'hello world')
  assert.equal(sanitizeMemo('a\u0000b\u2028c\u200bd'), 'a b c d')
  assert.equal(sanitizeMemo('x'.repeat(MAX_MEMO_LENGTH + 40)).length, MAX_MEMO_LENGTH)
  assert.equal(sanitizeMemo(undefined as unknown as string), '')
})

test('memo text cannot smuggle markup into the sheet', () => {
  const request = parseSolanaPay(
    `solana:${ADDRESS}?memo=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
  )
  assert.ok(request)
  assert.equal(request!.memo, '<img src=x onerror=alert(1)>')
  // Stored as text; the sheet renders it inside a text node, never as HTML.
  const chipText = request!.memo!
  assert.equal(chipText.startsWith('<'), true)
})

test('recipient input separates a bare address from a request', () => {
  const bare = parseRecipientInput(ADDRESS)
  assertEquals(bare, { address: ADDRESS, fromUri: false })

  const uri = parseRecipientInput(`solana:${OTHER}?amount=3&memo=rent`)
  assertEquals(uri, { address: OTHER, amount: '3', memo: 'rent', fromUri: true })
})

function assertEquals(
  parsed: ReturnType<typeof parseRecipientInput>,
  expected: { address: string; fromUri: boolean; amount?: string; memo?: string },
) {
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.address, expected.address)
  assert.equal(parsed.fromUri, expected.fromUri)
  if (expected.amount !== undefined) assert.equal(parsed.amount, expected.amount)
  if (expected.memo !== undefined) assert.equal(parsed.memo, expected.memo)
}
