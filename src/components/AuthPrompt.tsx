/**
 * The PIN check that stands in front of every action that needs the key.
 *
 * It is rendered by the wallet provider, not by a screen, so no amount of
 * navigation can leave a signing action without it: the sheet appears the
 * moment a screen asks for the key, and the request either resolves with a
 * decrypted keypair or with nothing.
 */
import { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { Sheet } from './Sheet'
import { Button } from './Button'
import { Keypad, PinDots } from './Keypad'
import { authPurposeInfo } from '../lib/authGate'
import { InvalidPinError } from '../lib/vault'

interface AuthPromptProps {
  /** The purpose waiting for a check, or null when nothing is pending. */
  purpose: string | null
  onCancel: () => void
  /** Verify the PIN and hand the key to the waiting action. Throws on a wrong PIN. */
  onSubmit: (pin: string) => Promise<void>
}

export function AuthPrompt({ purpose, onCancel, onSubmit }: AuthPromptProps) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorState, setErrorState] = useState(false)
  // Kept for the closing animation, so the sheet does not flash a generic title
  // while it slides away.
  const lastPurpose = useRef<string | null>(purpose)
  if (purpose) lastPurpose.current = purpose

  useEffect(() => {
    setPin('')
    setError(null)
    setBusy(false)
    setErrorState(false)
  }, [purpose])

  const info = authPurposeInfo(purpose ?? lastPurpose.current ?? '')

  const submit = async (value: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
    } catch (reason) {
      if (reason instanceof InvalidPinError) {
        setError('PIN이 올바르지 않습니다.')
        setPin('')
        setErrorState(true)
        window.setTimeout(() => setErrorState(false), 460)
      } else {
        setError((reason as Error)?.message || '인증하지 못했습니다. 저장된 데이터는 그대로입니다.')
        setPin('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={Boolean(purpose)}
      onClose={busy ? () => undefined : onCancel}
      title="인증이 필요합니다"
      subtitle={info.label}
    >
      <div className="flex flex-col" data-auth-prompt={purpose ?? lastPurpose.current ?? ''}>
        <div className="flex items-start gap-2.5 rounded-[16px] bg-surface px-4 py-3.5">
          <Lock size={16} className="mt-px shrink-0 text-ink" />
          <p className="text-[11.5px] leading-[1.65] text-ink2">{info.detail}</p>
        </div>

        <div className="mt-9 flex flex-col items-center">
          <PinDots value={pin} error={errorState} />
          <div className="mt-4 h-5 text-center text-[12.5px] text-danger">{error ?? ''}</div>
        </div>

        <div className="mt-3">
          <Keypad
            value={pin}
            onChange={(value) => {
              setPin(value)
              if (error) setError(null)
            }}
            onComplete={submit}
            disabled={busy}
            error={errorState}
            compact
          />
        </div>

        <div className="mt-4">
          <Button full variant="secondary" onClick={onCancel} disabled={busy}>
            취소
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
