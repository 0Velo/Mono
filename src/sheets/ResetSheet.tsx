import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { useWallet } from '../state/WalletProvider'
import { cx } from '../lib/format'

interface ResetSheetProps {
  open: boolean
  onClose: () => void
}

export function ResetSheet({ open, onClose }: ResetSheetProps) {
  const { resetWallet } = useWallet()
  const [ack, setAck] = useState(false)

  useEffect(() => {
    if (open) setAck(false)
  }, [open])

  return (
    <Sheet open={open} onClose={onClose} title="지갑 초기화">
      <div className="rounded-[16px] bg-dangerSoft p-4 text-[13px] leading-[1.7] text-danger">
        이 기기에 저장된 시드 문구와 PIN이 완전히 삭제됩니다. 시드 문구를 백업하지 않았다면 이
        지갑의 자산을 영구히 잃게 됩니다. 이 작업은 되돌릴 수 없습니다.
      </div>

      <button
        onClick={() => setAck((value) => !value)}
        className="mt-4 flex w-full items-start gap-2.5 rounded-[16px] bg-surface px-3.5 py-3.5 text-left"
      >
        <span
          className={cx(
            'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[7px] border text-onInk',
            ack ? 'border-ink bg-ink' : 'border-line bg-card',
          )}
        >
          {ack && <Check size={12} strokeWidth={3} />}
        </span>
        <span className="text-[12.5px] leading-snug text-ink2">
          시드 문구를 백업했거나 이 지갑의 자산을 포기하는 것에 동의합니다.
        </span>
      </button>

      <div className="mt-5 space-y-2">
        <Button
          full
          variant="danger"
          disabled={!ack}
          onClick={() => {
            resetWallet()
            onClose()
          }}
        >
          지갑 삭제
        </Button>
        <Button full variant="secondary" onClick={onClose}>
          취소
        </Button>
      </div>
    </Sheet>
  )
}
