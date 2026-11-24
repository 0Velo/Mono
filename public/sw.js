/* Minimal app-shell service worker: enables install + offline shell.
 * Scope-aware, so it also works when the app is served from a sub path
 * (GitHub Pages: https://cbalhub.github.io/sol-wallet/).
 *
 * v3: hashed asset names change with every deploy, so a new SW drops the old
 * caches on activate and the iPhone picks the new build on the next launch. */
const ROOT = new URL(self.registration.scope).pathname // e.g. '/sol-wallet/'
const CACHE_PREFIX = 'sol-wallet-shell-'
const CACHE = `${CACHE_PREFIX}v3`

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    // Network first so a fresh deploy is visible immediately; the cached shell
    // only answers when the phone is offline.
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          if (fresh.ok) {
            const cache = await caches.open(CACHE)
            event.waitUntil(cache.put(ROOT, fresh.clone()))
          }
          return fresh
        } catch {
          const cache = await caches.open(CACHE)
          return (await cache.match(ROOT)) || Response.error()
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (
        response.ok &&
        (url.pathname.startsWith(`${ROOT}assets/`) || url.pathname.startsWith(`${ROOT}fonts/`))
      ) {
        event.waitUntil(cache.put(request, response.clone()))
      }
      return response
    })(),
  )
})
