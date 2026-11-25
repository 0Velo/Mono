import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearVault, loadVault, saveVault } from '../../../src/lib/vaultStore'
import type { Vault } from '../../../src/lib/vault'

class FakeStorage {
  private readonly values = new Map<string, string>()
  failSet = false
  failRemove = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('quota')
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    if (this.failRemove) throw new Error('blocked')
    this.values.delete(key)
  }
}

const vault: Vault = {
  v: 1,
  alg: 'AES-GCM',
  kdf: 'PBKDF2-SHA256',
  iter: 210_000,
  salt: Buffer.alloc(16).toString('base64'),
  iv: Buffer.alloc(12).toString('base64'),
  ct: Buffer.alloc(17).toString('base64'),
  createdAt: 1,
}

let storage: FakeStorage
let originalStorage: PropertyDescriptor | undefined
let originalIndexedDB: PropertyDescriptor | undefined

beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  storage = new FakeStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB)
  else Reflect.deleteProperty(globalThis, 'indexedDB')
})

test('encrypted localStorage fallback can be saved and loaded when IndexedDB is unavailable', async () => {
  await saveVault(vault)
  assert.deepEqual(await loadVault(), vault)
})

test('fallback write failure is returned to the caller', async () => {
  storage.failSet = true
  await assert.rejects(() => saveVault(vault), /대체 저장소/)
})

test('corrupt stored data is not treated as an empty wallet', async () => {
  storage.setItem('mono.vault.fallback.v1', '{broken')
  await assert.rejects(() => loadVault(), /손상/)
})

test('clear failure is returned and the fallback copy remains untouched', async () => {
  await saveVault(vault)
  storage.failRemove = true
  await assert.rejects(() => clearVault(), /대체 저장소/)
  assert.equal(storage.getItem('mono.vault.fallback.v1'), JSON.stringify(vault))
})
