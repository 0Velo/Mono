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
  WATCH_PRESETS,
  addWatch,
  addWatchPresets,
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

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function syntheticAddress(index: number): string {
  const first = BASE58_ALPHABET[index % BASE58_ALPHABET.length]
  const second = BASE58_ALPHABET[Math.floor(index / BASE58_ALPHABET.length) % BASE58_ALPHABET.length]
  return `ABCDEFGHJKLMNPQRSTUVWXYZ${first}${second}${'x'.repeat(17)}`
}

function storedEntries(): any[] {
  return JSON.parse(storage.getItem('mono.watchWallets.v1') ?? '[]')
}

function clearWatchList(): void {
  for (const entry of storedEntries()) removeWatch(entry.id)
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

/** The 15 recommended whales exactly as the user listed them. */
const EXPECTED_PRESETS: [string, string][] = [
  ['Trunoest', 'ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT'],
  ['OGAntD', '215nhcAHjQQGgwpQSJQ7zR26etbjjtVdW74NLzwEgQjP'],
  ['Decu', '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9'],
  ['Cooker', '8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6'],
  ['Ansem', 'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm'],
  ['SKX', 'C4eZg1rJX6v1u7LzqermPrA1pDNNxQe6g3vyY5cHHoWq'],
  ['LJC', '6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2'],
  ['ozark', 'DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam'],
  ['rayan', 'BNahnx13rLru9zxuWNGBD7vVv1pGQXB11Q7qeTyupdWf'],
  ['Pain', 'J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa'],
  ['Mitch', '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t'],
  ['Jijo', '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk'],
  ['Frank DeGods', '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ'],
  ['Cap', 'CAPn1yH4oSywsxGU456jfgTrSSUidf9jgeAnHceNUJdw'],
  ['Dov', '8nqtxpFpuXwfXG4pBLsDkkuMMPK9FjSkBMCn542HiM3v'],
]

test('the recommended whales are fifteen fixed public addresses', () => {
  assert.deepEqual(WATCH_PRESETS.map((preset) => [preset.name, preset.address]), EXPECTED_PRESETS)
  assert.equal(new Set(WATCH_PRESETS.map((preset) => preset.address)).size, WATCH_PRESETS.length)
  for (const preset of WATCH_PRESETS) {
    assert.equal(looksLikeSolanaAddress(preset.address), true)
    assert.equal(normalizeWatchLabel(preset.name), preset.name)
  }
})

test('all recommended whales can be added in one tap with a single write', () => {
  clearWatchList()
  const first = addWatchPresets(WATCH_PRESETS, OWN)
  assert.deepEqual(first, { added: 15, alreadyTracked: 0, skipped: 0, reachedLimit: false })
  const stored = storedEntries()
  assert.deepEqual(stored.map((entry: any) => entry.label), WATCH_PRESETS.map((preset) => preset.name))
  assert.deepEqual(stored.map((entry: any) => entry.address), WATCH_PRESETS.map((preset) => preset.address))
  assert.ok(stored.every((entry: any) => entry.enabled === true))
  // Still only a public address and a label per row.
  for (const entry of stored) assert.deepEqual(Object.keys(entry).sort(), ['address', 'createdAt', 'enabled', 'id', 'label'])
  // A second tap skips every address instead of duplicating it.
  const again = addWatchPresets(WATCH_PRESETS, OWN)
  assert.deepEqual(again, { added: 0, alreadyTracked: 15, skipped: 0, reachedLimit: false })
  assert.equal(storedEntries().length, 15)
})

test('a single recommended whale can be added from its chip and is flagged afterwards', () => {
  clearWatchList()
  const preset = WATCH_PRESETS[2]
  assert.equal(addWatch(preset.name, preset.address, OWN).ok, true)
  assert.equal(addWatch(preset.name, preset.address, OWN).ok, false)
  assert.equal(storedEntries().length, 1)
  const rest = addWatchPresets(WATCH_PRESETS, OWN)
  assert.equal(rest.added, WATCH_PRESETS.length - 1)
  assert.equal(rest.alreadyTracked, 1)
  assert.equal(storedEntries().length, WATCH_PRESETS.length)
})

test('the cap is twenty wallets and a bulk add fills only the empty seats', () => {
  clearWatchList()
  assert.equal(MAX_WATCH_WALLETS, 20)
  for (let index = 0; index < MAX_WATCH_WALLETS - 1; index += 1) {
    assert.equal(addWatch(`수동 ${index}`, syntheticAddress(index), OWN).ok, true)
  }
  const result = addWatchPresets(WATCH_PRESETS, OWN)
  assert.equal(result.added, 1)
  assert.equal(result.reachedLimit, true)
  assert.equal(storedEntries().length, MAX_WATCH_WALLETS)
  assert.equal(storedEntries()[0].address, WATCH_PRESETS[0].address)
  // At the cap nothing more can be stored, by hand or by preset.
  assert.equal(addWatch('초과', syntheticAddress(40), OWN).ok, false)
  assert.equal(addWatchPresets(WATCH_PRESETS, OWN).added, 0)
})

test('a recommended whale that is the own wallet is skipped, not stored', () => {
  clearWatchList()
  const result = addWatchPresets(WATCH_PRESETS, WATCH_PRESETS[0].address)
  assert.equal(result.skipped, 1)
  assert.equal(result.added, WATCH_PRESETS.length - 1)
  assert.equal(storedEntries().some((entry: any) => entry.address === WATCH_PRESETS[0].address), false)
  clearWatchList()
})
