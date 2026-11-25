import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountIndices,
  readMeta,
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
