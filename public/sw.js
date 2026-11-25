/* Minimal app-shell service worker: enables install + offline shell.
 * Scope-aware, so it also works when the app is served from a sub path
 * (GitHub Pages: https://0velo.github.io/Mono/).
 *
 * v14 (Mono): 계정 목록 개수 제한 수정, 송금 확인 시간 제한, 스플래시 애니메이션.
 * v15 (Mono): 원격 Web Push 서버 연결(VITE_PUSH_API_URL). 앱을 닫아 둔 동안의
 * 입금 알림을 위해 서버에 기기를 등록할 수 있다.
 * v16 (Mono): 스플래시를 2.5초로 늘리고, 외계인이 우주선을 타고 날아가는
 * 장면으로 바꿨다(index.html의 CSS 키프레임 + 인라인 SVG).
 * v17 (Mono): SOL 코인 아이콘을 AI 생성 이미지에서 공식 솔라나 로고(정식 벡터
 * SVG, 검은 원형 배지)로 교체하고 아트 쿼리스트링을 v5로 올렸다.
 * Same caching rules as v14; hashed asset names change with every deploy, so a
 * new SW drops the old caches on activate and the iPhone picks the new build on
 * the next launch. */
const ROOT = new URL(self.registration.scope).pathname // e.g. '/Mono/'
const CACHE_PREFIX = 'mono-shell-'
const CACHE = `${CACHE_PREFIX}v17`

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

function safeNotificationUrl(value) {
  const fallback = new URL(ROOT, self.location.origin).toString()
  if (typeof value !== 'string') return fallback
  try {
    const url = new URL(value, self.location.origin)
    if (url.origin === self.location.origin && url.pathname.startsWith(ROOT)) return url.toString()
    if (url.protocol === 'https:' && url.hostname === 'solscan.io' && url.pathname.startsWith('/tx/')) {
      return url.toString()
    }
  } catch {
    // Ignore malformed notification URLs and open the app instead.
  }
  return fallback
}

function safeNotificationIcon(value) {
  const fallback = new URL('icons/icon-192.png', self.registration.scope).toString()
  if (typeof value !== 'string') return fallback
  try {
    const icon = new URL(value, self.registration.scope)
    if (icon.origin === self.location.origin) return icon.toString()
  } catch {
    // Use the bundled app icon for malformed or off-origin paths.
  }
  return fallback
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {}
    try {
      if (event.data) payload = event.data.json()
    } catch {
      payload = {}
    }
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 80)
      : 'Mono 알림'
    const body = typeof payload.body === 'string' ? payload.body.slice(0, 240) : '새 거래가 확인됐습니다.'
    const icon = safeNotificationIcon(payload.icon)
    await self.registration.showNotification(title, {
      body,
      icon,
      tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 120) : 'activity',
      data: { url: safeNotificationUrl(payload.url) },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const target = safeNotificationUrl(event.notification.data?.url)
      const targetUrl = new URL(target)
      if (targetUrl.origin !== self.location.origin) {
        await self.clients.openWindow(targetUrl.toString())
        return
      }
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const appWindow = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (appWindow) {
        await appWindow.focus()
        return
      }
      await self.clients.openWindow(new URL(ROOT, self.location.origin).toString())
    })(),
  )
})
