import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ACCOUNTS,
  accountIndices,
  legacyAccountIndices,
  nextAccountIndex,
  readMeta,
  sanitizeAccountIndices,
  writeMeta,
  type WalletMeta,
} from '../../../src/state/WalletProvider'
import { readRepoFile } from './helpers'

class FakeStorage {
  values = new Map<string, string>()
  failRead = false
  failWrite = false
  getItem(key: string): string | null {
    if (this.failRead) throw new Error('storage blocked')
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    if (this.failWrite) throw new Error('quota')
    this.values.set(key, value)
  }
}

let storage: FakeStorage
let originalStorage: PropertyDescriptor | undefined

beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  storage = new FakeStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

const meta = (overrides: Partial<WalletMeta> = {}): WalletMeta => ({
  address: 'registered-wallet-address',
  name: 'Mono',
  network: 'mainnet',
  rpc: { mainnet: '', devnet: '' },
  autoLockMinutes: 5,
  createdAt: 1,
  activeIndex: 0,
  accountNames: {},
  ...overrides,
})

test('account list includes the base and user-registered indices only', () => {
  assert.deepEqual(accountIndices(0), [0])
  assert.deepEqual(accountIndices(0, {}, [2, 5]), [0, 2, 5])
  assert.deepEqual(accountIndices(3, {}, [1, 3]), [0, 1, 3])
})

test('registered account indices and active account survive a metadata reload', () => {
  const registered = meta({ activeIndex: 4, accountIndices: [2, 4] })
  writeMeta(registered)

  const reloaded = readMeta()
  assert.deepEqual(reloaded?.accountIndices, [2, 4])
  assert.equal(reloaded?.activeIndex, 4)
  assert.deepEqual(accountIndices(reloaded!.activeIndex, reloaded!.accountNames, reloaded!.accountIndices), [0, 2, 4])
})

test('metadata write failure is reported and does not update saved metadata', () => {
  const existing = meta({ accountIndices: [1] })
  writeMeta(existing)
  storage.failWrite = true

  assert.throws(() => writeMeta(meta({ accountIndices: [1, 2] })), /설정을 저장하지 못했습니다/)
  storage.failWrite = false
  assert.deepEqual(readMeta()?.accountIndices, [1])
})

test('blocked metadata reads throw instead of appearing to be an empty install', () => {
  storage.failRead = true
  assert.throws(() => readMeta(), /storage blocked/)
})

test('initialization retains legacy auth and wallet data; clear remains user-invoked only', () => {
  const provider = readRepoFile('src/state/WalletProvider.tsx')
  const initialization = provider.slice(provider.indexOf('useEffect(() => {'), provider.indexOf('const persistMeta'))
  const idb = readRepoFile('src/lib/idb.ts')

  assert.doesNotMatch(initialization, /clearVault|removeItem|faceid/i)
  assert.doesNotMatch(idb, /deleteObjectStore/)
  assert.equal((provider.match(/clearVault\(/g) ?? []).length, 1)
})

/* ---------------------------------------------------- account registry */

test('a wallet can register far more than the three accounts older builds showed', () => {
  // The reported bug: a build hardcoded `[0, 1, 2]`, so "계정 추가" stopped
  // mattering. The registry must grow one index at a time.
  const indices: number[] = []
  for (let step = 1; step <= 12; step += 1) {
    const next = nextAccountIndex([0, ...indices])
    assert.equal(next, step)
    indices.push(next!)
  }
  assert.deepEqual(accountIndices(0, {}, indices), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.ok(MAX_ACCOUNTS >= 10, `MAX_ACCOUNTS is ${MAX_ACCOUNTS}`)
  assert.equal(MAX_ACCOUNTS, 100)
})

test('adding reuses the lowest free index after a delete, and the space can fill', () => {
  assert.equal(nextAccountIndex([0, 1, 2]), 3)
  assert.equal(nextAccountIndex([0, 2, 3]), 1)
  assert.equal(nextAccountIndex([0, 3]), 1)
  const full = [0, ...Array.from({ length: MAX_ACCOUNTS - 1 }, (_, position) => MAX_ACCOUNTS - 1 - position)]
  assert.equal(nextAccountIndex(full), null)
})

test('twelve accounts survive a metadata reload and keep their active index', () => {
  const registered = Array.from({ length: 12 }, (_, position) => position + 1)
  writeMeta(meta({ activeIndex: 7, accountIndices: registered }))
  const reloaded = readMeta()
  assert.deepEqual(reloaded?.accountIndices, registered)
  assert.equal(reloaded?.activeIndex, 7)
  assert.equal(accountIndices(reloaded!.activeIndex, reloaded!.accountNames, reloaded!.accountIndices).length, 13)
})

test('metadata written before the registry keeps exactly the accounts that build showed', () => {
  // Builds up to 2026-11-25 11:43 wrote no `accountIndices` and always derived
  // 0, 1, 2. On the third account that means [1, 2] must be restored.
  storage.values.set(
    'mono.meta.v1',
    JSON.stringify({
      address: 'legacy-wallet-address',
      name: 'Mono',
      network: 'mainnet',
      rpc: { mainnet: '', devnet: '' },
      autoLockMinutes: 5,
      createdAt: 1,
      activeIndex: 2,
      accountNames: {},
    }),
  )
  assert.deepEqual(readMeta()?.accountIndices, [1, 2])
  assert.deepEqual(legacyAccountIndices(2), [1, 2])
  assert.deepEqual(legacyAccountIndices(0, { 4: '투빗' }), [1, 2, 3, 4])
  assert.deepEqual(legacyAccountIndices(0), [])

  // An explicit (even empty) list is the new build's own record; never guess.
  storage.values.set(
    'mono.meta.v1',
    JSON.stringify({ address: 'wallet', activeIndex: 0, accountIndices: [] }),
  )
  assert.deepEqual(readMeta()?.accountIndices, [])
})

test('the registry rejects non-derivable indices instead of storing them', () => {
  assert.deepEqual(sanitizeAccountIndices([3, '2', 3, -1, 1.5, 100, Number.NaN]), [2, 3])
})

test('account management exposes add and delete and never a fixed three-account base', () => {
  const provider = readRepoFile('src/state/WalletProvider.tsx')
  const sheet = readRepoFile('src/sheets/AccountsSheet.tsx')
  assert.doesNotMatch(provider, /new Set<number>\(\[0, 1, 2/)
  assert.match(provider, /addAccount: \(\) => Promise<number>/)
  assert.match(provider, /removeAccount: \(index: number\) => Promise<void>/)
  assert.match(sheet, /addAccount\(\)/)
  assert.match(sheet, /await removeAccount\(index\)/)
  assert.match(sheet, /계정 삭제/)
})
