import { useState } from 'react'
import { BrandMark } from '../components/ui'
import { Keypad, PinDots } from '../components/Keypad'
import { Button } from '../components/Button'
import { Sheet } from '../components/Sheet'
import { useWallet } from '../state/WalletProvider'
import { shortAddress } from '../lib/format'

export function LockScreen() {
  const { unlock, resetWallet, meta } = useWallet()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [errorState, setErrorState] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showReset, setShowReset] = useState(false)

  const handle = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      await unlock(value)
    } catch {
      setError('PIN이 올바르지 않습니다.')
      setPin('')
      setErrorState(true)
      window.setTimeout(() => setErrorState(false), 460)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[430px] flex-col bg-white">
      <div className="safe-top" />
      <div className="flex flex-1 flex-col px-6 pb-[calc(env(safe-area-inset-bottom)+18px)]">
        <div className="flex flex-1 flex-col items-center justify-center">
          <BrandMark size={46} />
          <h1 className="mt-6 text-[19px] font-bold tracking-[-0.03em] text-ink">지갑 잠김</h1>
          <p className="mt-1.5 text-[12.5px] text-muted tnum">
            {meta ? shortAddress(meta.address, 5) : ''}
          </p>
          <div className="mt-9">
            <PinDots value={pin} error={errorState} />
            <div className="mt-4 h-5 text-center text-[12.5px] text-danger">{error ?? ''}</div>
          </div>
        </div>

        <Keypad
          value={pin}
          onChange={(value) => {
            setPin(value)
            if (error) setError(null)
          }}
          onComplete={handle}
          error={errorState}
          disabled={busy}
        />

        <button
          onClick={() => setShowReset(true)}
          className="mt-5 text-center text-[12px] text-muted underline-offset-2 active:underline"
        >
          PIN을 잊으셨나요?
        </button>
      </div>

      <Sheet open={showReset} onClose={() => setShowReset(false)} title="지갑 초기화">
        <div className="rounded-[16px] bg-dangerSoft p-4 text-[13px] leading-relaxed text-[#B4302F]">
          이 기기에 저장된 지갑을 완전히 삭제합니다. 시드 문구를 백업하지 않았다면 자산을 영구히
          잃게 됩니다. 되돌릴 수 없습니다.
        </div>
        <div className="mt-4 space-y-2">
          <Button
            full
            variant="danger"
            onClick={() => {
              resetWallet()
              setShowReset(false)
            }}
          >
            삭제하고 초기화
          </Button>
          <Button full variant="secondary" onClick={() => setShowReset(false)}>
            취소
          </Button>
        </div>
      </Sheet>
    </div>
  )
}
