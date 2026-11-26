import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Whale wallet list (고래 지갑) — the store is the source of truth on the device
 * and must only ever carry a public address and a one-line label.
 */

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, String(value)) }
  removeItem(key: string) { this.data.delete(key) }
  clear() { this.data.clear() }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const {
  MAX_WATCH_WALLETS,
  addWatch,
  looksLikeSolanaAddress,
  normalizeWatchLabel,
  removeWatch,
  updateWatch,
  watchEntriesPayload,
} = await import('../../../src/lib/watchWallets')
const { syncWatchList } = await import('../../../src/lib/pushSubscriptions')

const OWN = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const WHALE = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'
const OTHER = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'

function syntheticAddress(index: number): string {
  return `ABCDEFGHJKLMNPQRSTUVWXYZ${index + 2}${'x'.repeat(18)}`
}

test('watch labels stay one line and addresses are shape-checked only', () => {
  assert.equal(normalizeWatchLabel('  고래   1 '), '고래 1')
  assert.equal(normalizeWatchLabel('a'.repeat(40)).length, 24)
  assert.equal(normalizeWatchLabel('고\n래'), '')
  assert.equal(normalizeWatchLabel('   '), '')
  assert.equal(looksLikeSolanaAddress(OWN), true)
  assert.equal(looksLikeSolanaAddress(` ${OWN} `), true)
  assert.equal(looksLikeSolanaAddress('0OIl-not-base58'), false)
  assert.equal(looksLikeSolanaAddress('short'), false)
})

test('adding a whale wallet rejects the own wallet, duplicates and a full list', () => {
  assert.equal(addWatch('고래 1', WHALE, OWN).ok, true)
  assert.equal(addWatch('내 지갑', OWN, OWN).ok, false)
  assert.equal(addWatch('중복', WHALE, OWN).ok, false)
  assert.equal(addWatch('', OTHER, OWN).ok, false)
  assert.equal(addWatch('잘못된 주소', 'not-an-address', OWN).ok, false)

  for (let index = 0; index < MAX_WATCH_WALLETS + 2; index += 1) {
    addWatch(`고래 ${index}`, syntheticAddress(index), OWN)
  }
  const stored = JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]')
  assert.equal(stored.length, MAX_WATCH_WALLETS)
  // Nothing beyond a public address and a label is persisted.
  for (const entry of stored) {
    assert.deepEqual(Object.keys(entry).sort(), ['address', 'createdAt', 'enabled', 'id', 'label'])
  }
})

test('alerts can be toggled off and the label renamed without touching the address', () => {
  const before = JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]')
  const first = before[0]
  assert.equal(updateWatch(first.id, { enabled: false }), true)
  const toggled = JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]').find((entry: any) => entry.id === first.id)
  assert.equal(toggled.enabled, false)
  assert.equal(toggled.address, first.address)
  assert.equal(updateWatch(first.id, { label: '  새   별명 ' }), true)
  const renamed = JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]').find((entry: any) => entry.id === first.id)
  assert.equal(renamed.label, '새 별명')
  assert.equal(updateWatch(first.id, { label: '   ' }), false)
  assert.equal(updateWatch('missing', { enabled: true }), false)
})

test('the remote payload carries only address, label and enabled', () => {
  const stored = JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]')
  const payload = watchEntriesPayload(stored)
  assert.equal(payload.length, stored.length)
  for (const entry of payload) assert.deepEqual(Object.keys(entry).sort(), ['address', 'enabled', 'label'])
})

test('deleting removes only that wallet', () => {
  const before = JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]')
  const target = before[0]
  removeWatch(target.id)
  const after = JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]')
  assert.equal(after.length, before.length - 1)
  assert.equal(after.some((entry: any) => entry.id === target.id), false)
})

test('without a configured push server the list never leaves the device', async () => {
  let called = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    called = true
    throw new Error('network must not be touched without a configured push server')
  }) as typeof fetch
  try {
    assert.equal(await syncWatchList([{ address: WHALE, label: '고래 1', enabled: true }], 'mainnet'), false)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
