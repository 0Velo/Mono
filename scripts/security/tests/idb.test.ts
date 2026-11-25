import test from 'node:test'
import assert from 'node:assert/strict'
import { DB_NAME, STORE_VAULT, idbGet, openDb } from '../../../src/lib/idb'

test('database upgrade preserves old authentication records and read aborts reject', async () => {
  const names = new Set(['keys'])
  const authRecords = new Map([['device-auth', { credential: 'legacy-record' }]])
  const created: string[] = []
  let openName = ''
  let openVersion = 0
  let abortRead = false

  const database = {
    objectStoreNames: { contains: (name: string) => names.has(name) },
    createObjectStore: (name: string) => {
      names.add(name)
      created.push(name)
      return {}
    },
    deleteObjectStore: () => {
      throw new Error('upgrade attempted to delete an existing store')
    },
    close: () => undefined,
    transaction: () => {
      const tx: Record<string, unknown> = {
        error: abortRead ? new Error('legacy read aborted') : null,
      }
      tx.objectStore = () => ({
        get: () => {
          const request: Record<string, unknown> = { result: authRecords.get('device-auth') }
          queueMicrotask(() => {
            ;(request.onsuccess as (() => void) | undefined)?.()
            if (abortRead) (tx.onabort as (() => void) | undefined)?.()
            else (tx.oncomplete as (() => void) | undefined)?.()
          })
          return request
        },
      })
      return tx
    },
  } as unknown as IDBDatabase

  const indexedDBMock = {
    open: (name: string, version: number) => {
      openName = name
      openVersion = version
      const request: Record<string, unknown> = { result: database, error: null }
      queueMicrotask(() => {
        ;(request.onupgradeneeded as (() => void) | undefined)?.()
        ;(request.onsuccess as (() => void) | undefined)?.()
      })
      return request
    },
  }
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDBMock })

  try {
    const opened = await openDb()
    assert.equal(opened, database)
    assert.equal(openName, DB_NAME)
    assert.equal(openVersion, 2)
    assert.deepEqual(created, [STORE_VAULT])
    assert.deepEqual([...names].sort(), ['keys', STORE_VAULT].sort())
    assert.deepEqual(authRecords.get('device-auth'), { credential: 'legacy-record' })
    assert.deepEqual(await idbGet('keys', 'device-auth'), { credential: 'legacy-record' })

    abortRead = true
    await assert.rejects(() => idbGet('keys', 'device-auth'), /legacy read aborted/)
    assert.deepEqual(authRecords.get('device-auth'), { credential: 'legacy-record' })
  } finally {
    if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB)
    else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})
