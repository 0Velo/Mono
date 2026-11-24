/**
 * A very small IndexedDB wrapper — two stores, no dependencies.
 *
 * The encrypted vault and the Face ID wrapping key live here instead of in
 * localStorage: IndexedDB keeps binary values (a non-extractable CryptoKey is
 * a structured-clone type) and is not readable by a same-origin page's simple
 * `localStorage` scrape.
 */

export const DB_NAME = 'mono-vault'
const DB_VERSION = 1
export const STORE_VAULT = 'vault'
export const STORE_KEYS = 'keys'

let dbPromise: Promise<IDBDatabase> | null = null

export function idbSupported(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_VAULT)) db.createObjectStore(STORE_VAULT)
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB를 열지 못했습니다.'))
    request.onblocked = () => reject(new Error('IndexedDB가 다른 탭에서 사용 중입니다.'))
  })
  // A failed open must not poison every later call.
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

export async function idbGet<T>(store: string, key: string): Promise<T | null> {
  const db = await openDb()
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const request = tx.objectStore(store).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 읽기 실패'))
  })
}

export async function idbSet(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 쓰기 실패'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 쓰기 취소'))
  })
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 삭제 실패'))
  })
}
