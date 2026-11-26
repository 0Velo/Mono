import { Suspense, lazy, useEffect, useState } from 'react'
import { useWallet } from './state/WalletProvider'
import { Onboarding } from './screens/Onboarding'
import { LockScreen } from './screens/LockScreen'
import { ShellSkeleton } from './screens/ShellSkeleton'
import { prefetchKeys } from './lib/keys'
import { beginSplashLanding, hideAppSplash } from './lib/splash'
import { fetchDeployedBuild, isNewerBuild } from './lib/update'
import {
  ACTIVITY_NOTIFICATION_SETTING_EVENT,
  isActivityNotificationsEnabled,
} from './lib/activityNotifications'

/**
 * Everything behind the lock (web3.js, spl-token, the send flow) is one lazy
 * chunk. That keeps the first paint — onboarding and the PIN screen — at a
 * fraction of the old 708 KB bundle, and the chunk is warmed during idle time
 * so unlocking still feels instant.
 */
const Shell = lazy(() => import('./Shell'))
const ActivityMonitor = lazy(() => import('./components/ActivityMonitor'))

function SecureContextGate({ children }: { children: React.ReactNode }) {
  const secure =
    typeof window !== 'undefined' && window.isSecureContext && Boolean(window.crypto?.subtle)
  if (secure) return <>{children}</>
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[430px] flex-col justify-center bg-base px-8 text-center">
      <div className="text-[18px] font-bold tracking-tight">HTTPS에서 열어 주세요</div>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        이 지갑은 브라우저의 암호화 API(WebCrypto)로 시드 문구를 암호화합니다. 암호화 API는
        HTTPS 또는 localhost에서만 동작합니다. 배포된 주소(https://)로 접속하거나 기기에 앱으로
        설치해 사용하세요.
      </p>
    </div>
  )
}

export default function App() {
  const { ready, initializationError, vaultExists, unlocked, canView, meta } = useWallet()
  const [monitorEnabled, setMonitorEnabled] = useState(isActivityNotificationsEnabled)
  const [updateAvailable, setUpdateAvailable] = useState(false)

  // A home-screen app can resume from a page iOS kept suspended for days, still
  // running the JavaScript it loaded back then. Check the deployed build id on
  // launch and whenever the app comes back to the foreground, and offer a
  // deliberate re-open instead of silently showing stale code.
  useEffect(() => {
    let cancelled = false
    let lastCheck = 0
    const check = async () => {
      if (Date.now() - lastCheck < 60_000) return
      lastCheck = Date.now()
      const deployed = await fetchDeployedBuild()
      if (!cancelled && isNewerBuild(deployed)) setUpdateAvailable(true)
    }
    void check()
    const onForeground = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onForeground)
    window.addEventListener('online', onForeground)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onForeground)
      window.removeEventListener('online', onForeground)
    }
  }, [])

  useEffect(() => {
    const syncPreference = () => setMonitorEnabled(isActivityNotificationsEnabled())
    window.addEventListener(ACTIVITY_NOTIFICATION_SETTING_EVENT, syncPreference)
    document.addEventListener('visibilitychange', syncPreference)
    return () => {
      window.removeEventListener(ACTIVITY_NOTIFICATION_SETTING_EVENT, syncPreference)
      document.removeEventListener('visibilitychange', syncPreference)
    }
  }, [])

  // The splash is plain HTML in index.html, so it paints before any script
  // runs. It only leaves once the vault is read, so the app is never revealed
  // half-built.
  useEffect(() => {
    if (!ready) return
    // 지갑이 있어 잠금 화면으로 들어가면, 스플래시는 그냥 사라지지 않는다:
    // 우주선이 외계인을 키패드 위 마스코트 자리로 내려놓고 떠나고, 잠금
    // 화면의 진짜 `MonoMark`가 그 자리를 이어받는다. 온보딩 첫 방문(지갑 없음)
    // 이거나 모션을 줄여 달라고 한 경우에는 기존 마무리(발진 + 워드마크) 그대로.
    // 조회 자동 로그인으로 바로 홈에 들어가는 경우에는 착륙할 키패드가 없으니
    // 기본 마무리를 쓴다.
    if (vaultExists && !canView) beginSplashLanding()
    hideAppSplash()
  }, [ready])

  // Warm the heavy chunks while the person is still on the lock screen or
  // reading the seed phrase: nothing blocks, and the swap is instant.
  useEffect(() => {
    if (!vaultExists) return
    const warm = () => {
      void import('./Shell')
      prefetchKeys()
    }
    const idle = window.requestIdleCallback?.bind(window)
    let handle: number | undefined
    const timer = window.setTimeout(() => {
      if (idle) handle = idle(warm, { timeout: 2500 })
      else warm()
    }, 700)
    return () => {
      window.clearTimeout(timer)
      if (handle !== undefined) window.cancelIdleCallback?.(handle)
    }
  }, [vaultExists])

  if (!ready) {
    return <div className="min-h-full bg-base" />
  }

  if (initializationError) {
    return (
      <SecureContextGate>
        <div className="mx-auto flex min-h-full w-full max-w-[430px] flex-col justify-center bg-base px-8 text-center">
          <h1 className="text-[18px] font-bold tracking-tight">지갑 데이터를 불러오지 못했습니다</h1>
          <p className="mt-3 text-[13px] leading-relaxed text-muted">{initializationError}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 rounded-full bg-ink px-5 py-3 text-[13px] font-semibold text-onInk"
          >
            다시 시도
          </button>
        </div>
      </SecureContextGate>
    )
  }

  return (
    <SecureContextGate>
      {!vaultExists ? (
        <Onboarding />
      ) : !canView ? (
        <LockScreen />
      ) : (
        <Suspense fallback={<ShellSkeleton />}>
          <Shell />
        </Suspense>
      )}
      {updateAvailable && vaultExists && !unlocked && (
        <button
          onClick={() => window.location.reload()}
          className="fixed inset-x-0 top-[calc(env(safe-area-inset-top)+10px)] z-[60] mx-auto w-max rounded-full bg-ink px-4 py-2 text-[12px] font-semibold text-onInk shadow-[0_10px_28px_rgba(0,0,0,0.2)]"
        >
          새 버전이 있어요 · 탭해서 새로 열기
        </button>
      )}
      {vaultExists && meta?.address && monitorEnabled && (
        <Suspense fallback={null}>
          <ActivityMonitor
            address={meta.address}
            network={meta.network}
            rpc={meta.rpc[meta.network] ?? ''}
          />
        </Suspense>
      )}
    </SecureContextGate>
  )
}
