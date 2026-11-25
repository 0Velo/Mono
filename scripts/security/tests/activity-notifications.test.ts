/**
 * 입출금 알림 — 분류/중복 방지 규칙.
 *
 * 이 파일이 지키려는 약속:
 *   - 입금·출금·스왑을 각각 한 번씩만, 맞는 방향으로 알린다.
 *   - 앱을 처음 연 사람에게 과거 거래가 "새 입금"으로 쏟아지지 않는다.
 *   - 같은 서명은 두 번 알리지 않는다.
 *   - 알림 문구에는 시드·개인키·전체 주소가 들어가지 않는다.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeActivity,
  isIosUserAgent,
  selectNewActivity,
} from '../../../src/lib/activityNotifications'
import type { HistoryItem, TokenDelta } from '../../../src/lib/tx'

const SOL = 1_000_000_000
const FEE = 5000n
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const UNKNOWN_MINT = 'Zzzz111122223333444455556666777788889999'

function token(mint: string, amount: bigint, decimals: number): TokenDelta {
  return {
    mint,
    amount: amount.toString(),
    decimals,
    uiAmount: Number(amount < 0n ? -amount : amount) / 10 ** decimals,
  }
}

function item(overrides: Partial<HistoryItem> & Pick<HistoryItem, 'signature'>): HistoryItem {
  return {
    slot: 1,
    blockTime: 1_700_000_000,
    failed: false,
    detailed: true,
    solDelta: 0,
    tokenDeltas: [],
    ...overrides,
  }
}

test('a native SOL transfer in reads as an incoming deposit', () => {
  const event = describeActivity(item({ signature: 'dep', solDelta: 2 * SOL, feeLamports: 5000 }))
  assert.ok(event)
  assert.equal(event.kind, 'received')
  assert.equal(event.title, '입금 확인')
  assert.equal(event.body, '2 SOL 입금이 확인됐습니다.')
})

test('an outgoing SOL transfer reports the amount without the network fee', () => {
  const sent = BigInt(SOL) + FEE
  const event = describeActivity(item({ signature: 'send', solDelta: -Number(sent), feeLamports: Number(FEE) }))
  assert.ok(event)
  assert.equal(event.kind, 'sent')
  assert.equal(event.body, '1 SOL 출금이 확인됐습니다.')
})

test('a fee-only transaction is not announced', () => {
  assert.equal(describeActivity(item({ signature: 'fee', solDelta: -Number(FEE), feeLamports: Number(FEE) })), null)
  assert.equal(describeActivity(item({ signature: 'zero' })), null)
})

test('an SPL transfer in and out use the token symbol and decimals', () => {
  const received = describeActivity(item({ signature: 'usdc-in', tokenDeltas: [token(USDC, 12_500_000n, 6)] }))
  assert.ok(received)
  assert.equal(received.kind, 'received')
  assert.equal(received.body, '12.5 USDC 입금이 확인됐습니다.')

  const sent = describeActivity(item({ signature: 'usdc-out', tokenDeltas: [token(USDC, -3_000_000n, 6)] }))
  assert.ok(sent)
  assert.equal(sent.kind, 'sent')
  assert.equal(sent.body, '3 USDC 출금이 확인됐습니다.')
})

test('a token-to-token swap is one "스왑 완료" event, not a deposit plus a withdrawal', () => {
  const event = describeActivity(item({
    signature: 'swap',
    tokenDeltas: [token(USDC, -25_000_000n, 6), token(JUP, 4_100_000n, 6)],
    solDelta: -Number(FEE),
    feeLamports: Number(FEE),
  }))
  assert.ok(event)
  assert.equal(event.kind, 'swap')
  assert.equal(event.title, '스왑 완료')
  assert.equal(event.body, '25 USDC → 4.1 JUP')
})

test('a swap that spends SOL for a token is still a swap', () => {
  const event = describeActivity(item({
    signature: 'sol-swap',
    tokenDeltas: [token(USDC, 10_000_000n, 6)],
    solDelta: -Number(200_000_000n + FEE),
    feeLamports: Number(FEE),
  }))
  assert.ok(event)
  assert.equal(event.kind, 'swap')
  assert.equal(event.body, '0.2 SOL → 10 USDC')
})

test('an unknown mint falls back to a short uppercase tag, never a full address', () => {
  const event = describeActivity(item({ signature: 'unknown', tokenDeltas: [token(UNKNOWN_MINT, 5_000_000n, 6)] }))
  assert.ok(event)
  assert.equal(event.body, '5 ZZZZ 입금이 확인됐습니다.')
  assert.ok(!event.body.includes(UNKNOWN_MINT))
})

test('failed and not-yet-detailed transactions are never announced', () => {
  assert.equal(describeActivity(item({ signature: 'failed', failed: true, solDelta: SOL })), null)
  assert.equal(describeActivity(item({ signature: 'pending', detailed: false, solDelta: SOL })), null)
})

test('the first read only records a baseline and announces nothing', () => {
  const items = [
    item({ signature: 'old-1', slot: 3, solDelta: 5 * SOL }),
    item({ signature: 'old-2', slot: 2, solDelta: -SOL, feeLamports: Number(FEE) }),
  ]
  const selection = selectNewActivity(null, items)
  assert.equal(selection.baseline, true)
  assert.deepEqual(selection.events, [])
  assert.deepEqual(selection.seen.sort(), ['old-1', 'old-2'])
})

test('after the baseline, only a new signature is announced and it is announced once', () => {
  const baseline = [item({ signature: 'old-1', slot: 1, solDelta: SOL })]
  const seen = selectNewActivity(null, baseline).seen

  const withDeposit = [
    item({ signature: 'new-1', slot: 9, solDelta: 3 * SOL }),
    ...baseline,
  ]
  const first = selectNewActivity(seen, withDeposit)
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].signature, 'new-1')
  assert.ok(first.seen.includes('new-1'))

  const second = selectNewActivity(first.seen, withDeposit)
  assert.deepEqual(second.events, [])
})

test('several new transactions are announced oldest first', () => {
  const items = [
    item({ signature: 'new-b', slot: 12, solDelta: 2 * SOL }),
    item({ signature: 'new-a', slot: 11, tokenDeltas: [token(USDC, -1_000_000n, 6)] }),
  ]
  const selection = selectNewActivity([], items)
  assert.deepEqual(selection.events.map((event) => event.signature), ['new-a', 'new-b'])
})

test('a transaction whose details are not loaded yet is retried instead of being swallowed', () => {
  const pending = item({ signature: 'later', slot: 5, detailed: false, solDelta: 4 * SOL })
  const first = selectNewActivity([], [pending])
  assert.deepEqual(first.events, [])
  assert.ok(!first.seen.includes('later'), 'undetailed signature must stay unseen for the next poll')

  const detailed = { ...pending, detailed: true }
  const second = selectNewActivity(first.seen, [detailed])
  assert.equal(second.events.length, 1)
  assert.equal(second.events[0].signature, 'later')
})

test('the seen list stays bounded so localStorage cannot grow without limit', () => {
  const previous = Array.from({ length: 600 }, (_, index) => `sig-${index}`)
  const selection = selectNewActivity(previous, [item({ signature: 'brand-new', slot: 900, solDelta: SOL })])
  assert.ok(selection.seen.length <= 500)
  assert.ok(selection.seen.includes('brand-new'))
  assert.equal(selection.events.length, 1)
})

test('iPhone user agents are recognised so the UI can ask for a Home Screen install', () => {
  assert.equal(isIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'), true)
  assert.equal(isIosUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), true)
  assert.equal(isIosUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), false)
  assert.equal(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false)
})
