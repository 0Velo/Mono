/**
 * Area 9 — the two lines that stop a mistyped transfer: who the address is, and
 * what the wallet looks like afterwards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RENT_EXEMPT_MIN_LAMPORTS,
  describeRecipient,
  remainingSolAfterSend,
  remainingSolWarning,
} from '../../../src/lib/sendSafety'

const OWNER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const SECOND = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const NAMED = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BOOK = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'
const UNKNOWN = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'

const context = {
  owner: OWNER,
  accounts: [
    { index: 0, address: OWNER, name: '메인' },
    { index: 1, address: SECOND, name: '계정 2' },
    { index: 3, address: NAMED, name: '투빗' },
  ],
  book: [{ label: '업비트', address: BOOK }],
}

test('an own account is named by its number, not shown as a stranger', () => {
  const badge = describeRecipient(SECOND, context)
  assert.deepEqual(badge, { kind: 'own', label: '내 계정 2', caution: false })
})

test('a renamed own account keeps the name', () => {
  const badge = describeRecipient(NAMED, context)
  assert.deepEqual(badge, { kind: 'own', label: '내 계정 · 투빗', caution: false })
})

test('the active account says so, and is still a caution', () => {
  const badge = describeRecipient(OWNER, context)
  assert.equal(badge?.kind, 'self')
  assert.equal(badge?.label, '현재 계정')
  assert.equal(badge?.caution, true)
})

test('an address-book entry shows its own label', () => {
  assert.deepEqual(describeRecipient(BOOK, context), {
    kind: 'book',
    label: '업비트',
    caution: false,
  })
})

test('an address seen for the first time is the caution chip', () => {
  assert.deepEqual(describeRecipient(UNKNOWN, context), {
    kind: 'external',
    label: '처음 보내는 주소',
    caution: true,
  })
})

test('nothing is shown before an address exists', () => {
  assert.equal(describeRecipient('', context), null)
  assert.equal(describeRecipient('   ', context), null)
})

test('the SOL left after a transfer subtracts amount, fee and token-account rent', () => {
  const remaining = remainingSolAfterSend({
    kind: 'sol',
    amount: 500_000_000n,
    solBalance: 1_000_000_000n,
    feeLamports: 5_000n,
    rentLamports: 0n,
  })
  assert.equal(remaining, 499_995_000n)

  const tokenSend = remainingSolAfterSend({
    kind: 'spl',
    amount: 1_000_000n,
    solBalance: 10_000_000n,
    feeLamports: 5_000n,
    rentLamports: 2_039_280n,
  })
  assert.equal(tokenSend, 10_000_000n - 5_000n - 2_039_280n)
})

test('a transfer that cannot be paid shows a negative remainder', () => {
  const remaining = remainingSolAfterSend({
    kind: 'sol',
    amount: 1_000_000_000n,
    solBalance: 1_000_000_000n,
    feeLamports: 5_000n,
    rentLamports: 0n,
  })
  assert.equal(remaining, -5_000n)
  assert.match(remainingSolWarning(remaining) ?? '', /모자랍니다/)
})

test('the near-zero warning fires below the rent-exempt minimum only', () => {
  assert.equal(remainingSolWarning(RENT_EXEMPT_MIN_LAMPORTS), null)
  assert.match(remainingSolWarning(RENT_EXEMPT_MIN_LAMPORTS - 1n) ?? '', /0에 가까워요/)
  assert.equal(remainingSolWarning(5_000_000_000n), null)
})
