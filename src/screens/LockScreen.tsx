import { useEffect, useState } from 'react'
import { MonoMark } from '../components/ui'
import { MonoFace, type MonoMood } from '../components/MonoFace'
import { Keypad, PinDots } from '../components/Keypad'
import { Button } from '../components/Button'
import { Sheet } from '../components/Sheet'
import { InvalidPinError, useWallet } from '../state/WalletProvider'
import { shortAddress, cx } from '../lib/format'

interface LockScreenProps {
  /**
   * 정답 뒤의 짧은 인사. `Shell`로 넘어가기 전 App이 이 화면을 잠깐 붙잡아
   * 두는 동안 true가 되고, 마스코트가 반기고 나머지 글자는 흐려진다.
   */
  celebrating?: boolean
}

export function LockScreen({ celebrating = false }: LockScreenProps) {
  const { unlock, resetWallet, meta } = useWallet()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [errorState, setErrorState] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [showReset, setShowReset] = useState(false)
  const [mood, setMood] = useState<MonoMood>('idle')

  useEffect(() => {
    if (celebrating) setMood('success')
  }, [celebrating])

  const handle = async (value: string) => {
    setBusy(true)
    setError(null)
    setMood('typing')
    try {
      await unlock(value)
    } catch (reason) {
      if (reason instanceof InvalidPinError) {
        setError('PIN이 올바르지 않습니다.')
        setPin('')
        setErrorState(true)
        setMood('error')
        window.setTimeout(() => setErrorState(false), 460)
        window.setTimeout(() => setMood((current) => (current === 'error' ? 'idle' : current)), 900)
      } else {
        setMood('idle')
        setError((reason as Error)?.message || '지갑을 열지 못했습니다. 저장된 데이터는 삭제하지 않았습니다.')
      }
    } finally {
      setBusy(false)
    }
  }

  // 빈 칸을 눌러 지웠을 때도 마스코트는 다시 기본 표정으로 돌아온다.
  useEffect(() => {
    if (pin.length === 0 && mood === 'typing') setMood('idle')
  }, [pin, mood])

  return (
    <div
      className={cx(
        'mx-auto flex min-h-full w-full max-w-[430px] flex-col bg-base',
        celebrating && 'mono-lock-celebrating',
      )}
    >
      <div className="safe-top" />
      <div className="mono-lock-content flex flex-1 flex-col px-6 pb-[calc(env(safe-area-inset-bottom)+18px)]">
        <div className="flex flex-1 flex-col items-center justify-center">
          {/* The splash lands the alien exactly here; the mark then takes over. */}
          <div
            className="relative flex h-[92px] w-[92px] items-center justify-center"
            data-mono-landing-target
          >
            {/*
             * 표정 모션은 마스코트를 감싸는 이 층에서만 움직인다. 랜딩 대상의
             * 사각형(92×92)과 `MonoMark`의 래스터는 그대로여서, 스플래시가
             * 좌표를 재는 시점에도 값이 변하지 않는다.
             */}
            <div
              className={cx(
                'relative h-full w-full',
                mood === 'idle' && 'mono-mood-idle',
                mood === 'typing' && 'mono-mood-typing',
                mood === 'error' && 'mono-mood-error',
                mood === 'success' && 'mono-mood-success',
              )}
              data-mono-mood={mood}
            >
              <MonoMark size={92} className="mono-land-mark" />
              <MonoFace mood={mood} />
            </div>
          </div>
          <div className="mono-lock-fade flex flex-col items-center">
            <h1 className="mt-4 text-[19px] font-bold tracking-[-0.03em] text-ink">지갑 잠김</h1>
            <p className="mt-1.5 text-[12.5px] text-muted tnum">
              {meta ? shortAddress(meta.address, 5) : ''}
            </p>

            <div className="mt-8">
              <PinDots value={pin} error={errorState} />
              <div className="mt-4 h-5 max-w-[280px] text-center text-[12.5px] leading-snug text-danger">
                {error ?? ''}
              </div>
            </div>
          </div>
        </div>

        <div className="mono-lock-fade">
          <Keypad
            value={pin}
            onChange={(value) => {
              setPin(value)
              if (error) setError(null)
            }}
            onComplete={handle}
            error={errorState}
            disabled={busy || celebrating}
          />

          <button
            onClick={() => setShowReset(true)}
            className="mt-5 w-full text-center text-[12px] text-muted underline-offset-2 active:underline"
          >
            PIN을 잊으셨나요?
          </button>

          {meta && !meta.autoLogin && (
            <p className="mt-2 text-center text-[11px] leading-[1.6] text-faint">
              잠금 없이 잔액만 보려면 설정 → 보안에서
              <br />
              자동 로그인 (조회 전용)을 켜세요.
            </p>
          )}
        </div>
      </div>

      <Sheet open={showReset} onClose={() => setShowReset(false)} title="지갑 초기화">
        <div className="rounded-[16px] bg-dangerSoft p-4 text-[13px] leading-relaxed text-danger">
          이 기기에 저장된 지갑을 완전히 삭제합니다. 시드 문구나 암호화 백업 파일이 없다면 자산을
          영구히 잃게 됩니다. 되돌릴 수 없습니다.
        </div>
        <div className="mt-4 space-y-2">
          <Button
            full
            variant="danger"
            onClick={async () => {
              setResetError(null)
              try {
                await resetWallet()
                setShowReset(false)
              } catch (reason) {
                setResetError((reason as Error)?.message || '지갑을 초기화하지 못했습니다.')
              }
            }}
          >
            삭제하고 초기화
          </Button>
          {resetError && <p className="text-center text-[12px] text-danger">{resetError}</p>}
          <Button full variant="secondary" onClick={() => setShowReset(false)}>
            취소
          </Button>
        </div>
      </Sheet>
    </div>
  )
}
