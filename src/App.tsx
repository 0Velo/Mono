import { Suspense, lazy, useEffect } from 'react'
import { useWallet } from './state/WalletProvider'
import { Onboarding } from './screens/Onboarding'
import { LockScreen } from './screens/LockScreen'
import { ShellSkeleton } from './screens/ShellSkeleton'
import { prefetchKeys } from './lib/keys'

/**
 * Everything behind the lock (web3.js, spl-token, the send flow) is one lazy
 * chunk. That keeps the first paint — onboarding and the PIN screen — at a
 * fraction of the old 708 KB bundle, and the chunk is warmed during idle time
 * so unlocking still feels instant.
 */
const Shell = lazy(() => import('./Shell'))

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
  const { ready, vaultExists, unlocked } = useWallet()

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

  return (
    <SecureContextGate>
      {!vaultExists ? (
        <Onboarding />
      ) : !unlocked ? (
        <LockScreen />
      ) : (
        <Suspense fallback={<ShellSkeleton />}>
          <Shell />
        </Suspense>
      )}
    </SecureContextGate>
  )
}
