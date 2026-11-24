import { useEffect, useState } from 'react'
import { Copy, Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { Keypad, PinDots } from '../components/Keypad'
import { showToast } from '../components/Toast'
import { useWallet } from '../state/WalletProvider'
import type { SecretPayload } from '../lib/vault'
import { mnemonicWords } from '../lib/wallet'

interface BackupSheetProps {
  open: boolean
  onClose: () => void
}

export function BackupSheet({ open, onClose }: BackupSheetProps) {
  const { verifyPin } = useWallet()
  const [pin, setPin] = useState('')
  const [secret, setSecret] = useState<SecretPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (!open) return
    setPin('')
    setSecret(null)
    setError(null)
    setRevealed(false)
  }, [open])

  const submit = async (value: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const payload = await verifyPin(value)
      setSecret(payload)
      setPin('')
    } catch {
      setError('PIN이 올바르지 않습니다.')
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast('복사했습니다. 안전한 곳에 보관하세요.')
    } catch {
      showToast('복사할 수 없습니다')
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="시드 문구" subtitle="PIN을 확인한 뒤에만 볼 수 있습니다.">
      {!secret && (
        <div className="flex flex-col px-1">
          <div className="flex items-start gap-2.5 rounded-[16px] bg-surface px-4 py-3.5">
            <ShieldAlert size={16} className="mt-px shrink-0 text-ink" />
            <p className="text-[11.5px] leading-[1.65] text-ink2">
              화면 공유, 캡처, 사진 촬영을 피하세요. 이 문구를 가진 사람은 지갑의 모든 자산을 옮길 수
              있습니다.
            </p>
          </div>

          <div className="mt-10 flex flex-col items-center">
            <PinDots value={pin} error={Boolean(error)} />
            <div className="mt-4 h-5 text-[12px] text-danger">{error ?? ''}</div>
          </div>

          <div className="mt-4">
            <Keypad
              value={pin}
              onChange={(value) => {
                setPin(value)
                if (error) setError(null)
              }}
              onComplete={submit}
              disabled={busy}
              compact
            />
          </div>
        </div>
      )}

      {secret && secret.kind === 'mnemonic' && (
        <div className="animate-fade">
          <div className="grid grid-cols-3 gap-2">
            {mnemonicWords(secret.mnemonic).map((word, index) => (
              <div
                key={`${word}-${index}`}
                className="flex items-baseline gap-1.5 rounded-[14px] bg-surface px-3 py-2.5"
              >
                <span className="tnum text-[10px] text-[#A9AFB9]">{index + 1}</span>
                <span className="text-[13.5px] font-semibold tracking-[-0.02em] text-ink">{word}</span>
              </div>
            ))}
          </div>
          <div className="mt-5 flex gap-2">
            <Button full variant="secondary" onClick={() => copy(secret.mnemonic)}>
              <Copy size={15} /> 복사
            </Button>
          </div>
          <p className="mt-4 text-[11.5px] leading-[1.7] text-[#A9AFB9]">
            이 순서 그대로 다른 지갑 앱에 입력하면 같은 주소가 복원됩니다. (경로{' '}
            <span className="font-mono">{secret.path}</span>)
          </p>
        </div>
      )}

      {secret && secret.kind === 'secretKey' && (
        <div className="animate-fade">
          <div className="relative rounded-[16px] bg-surface p-4">
            <div
              className={
                revealed
                  ? 'break-all font-mono text-[12px] leading-relaxed text-ink'
                  : 'select-none break-all font-mono text-[12px] leading-relaxed text-ink blur-[5px]'
              }
            >
              {secret.secretKey}
            </div>
            <button
              onClick={() => setRevealed((value) => !value)}
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-ink active:bg-[#F0F2F5]"
              aria-label={revealed ? '숨기기' : '보기'}
            >
              {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <div className="mt-5">
            <Button full variant="secondary" onClick={() => copy(secret.secretKey)}>
              <Copy size={15} /> 개인키 복사
            </Button>
          </div>
          <p className="mt-4 text-[11.5px] leading-[1.7] text-[#A9AFB9]">
            이 지갑은 개인키로 가져왔기 때문에 시드 문구가 없습니다. 개인키를 안전하게 보관하세요.
          </p>
        </div>
      )}
    </Sheet>
  )
}
