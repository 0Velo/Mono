import { useMemo, useState } from 'react'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { Segmented } from '../components/ui'
import { Button } from '../components/Button'
import { Keypad, PinDots } from '../components/Keypad'
import { showToast } from '../components/Toast'
import { useWallet } from '../state/WalletProvider'
import {
  generateMnemonic,
  mnemonicWords,
  normalizeMnemonic,
  secretPayloadFromMnemonic,
  validateMnemonic,
} from '../lib/wallet'
import type { SecretPayload } from '../lib/vault'
import { cx } from '../lib/format'

type Step = 'start' | 'backup' | 'import' | 'pin'
type ImportMode = 'mnemonic' | 'secretKey'

export function Onboarding() {
  const { createWallet } = useWallet()
  const [step, setStep] = useState<Step>('start')
  const [mnemonic, setMnemonic] = useState('')
  const [importMode, setImportMode] = useState<ImportMode>('mnemonic')
  const [importText, setImportText] = useState('')
  const [confirmedBackup, setConfirmedBackup] = useState(false)
  const [payload, setPayload] = useState<SecretPayload | null>(null)
  const [pin, setPin] = useState('')
  const [pinStage, setPinStage] = useState<'set' | 'confirm'>('set')
  const [firstPin, setFirstPin] = useState('')
  const [pinError, setPinError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const words = useMemo(() => mnemonicWords(importText), [importText])
  const importValid =
    importMode === 'mnemonic' ? validateMnemonic(importText) : importText.trim().length > 20

  const startCreate = () => {
    const next = generateMnemonic(12)
    setMnemonic(next)
    setPayload(secretPayloadFromMnemonic(next))
    setStep('backup')
  }

  const beginWithBackup = () => {
    setPayload(secretPayloadFromMnemonic(mnemonic))
    setStep('pin')
  }

  const beginWithImport = () => {
    if (importMode === 'mnemonic') {
      if (!validateMnemonic(importText)) {
        setError('시드 문구가 올바르지 않습니다. 단어와 순서를 확인하세요.')
        return
      }
      setPayload({
        kind: 'mnemonic',
        mnemonic: normalizeMnemonic(importText),
        path: "m/44'/501'/0'/0'",
      })
    } else {
      setPayload({ kind: 'secretKey', secretKey: importText.trim(), path: "m/44'/501'/0'/0'" })
    }
    setError(null)
    setStep('pin')
  }

  const handlePin = async (value: string) => {
    setPinError(false)
    if (pinStage === 'set') {
      setFirstPin(value)
      setPin('')
      setPinStage('confirm')
      return
    }
    if (value !== firstPin) {
      setPinError(true)
      setError('PIN이 일치하지 않습니다. 다시 입력하세요.')
      setPin('')
      setPinStage('set')
      setFirstPin('')
      return
    }
    if (!payload) return
    setBusy(true)
    try {
      await createWallet(payload, value)
    } catch (err: any) {
      setError(err?.message || '지갑을 만들지 못했습니다.')
      setPin('')
      setPinStage('set')
      setFirstPin('')
      setBusy(false)
    }
  }

  const copyMnemonic = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic)
      showToast('시드 문구를 복사했습니다')
    } catch {
      showToast('복사할 수 없습니다')
    }
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[430px] flex-col bg-white">
      <div className="safe-top" />

      {step === 'start' && (
        <div className="animate-fade flex flex-1 flex-col px-6 pb-10 pt-8">
          <div className="flex flex-1 flex-col justify-center pb-4">
            <img
              src={`${import.meta.env.BASE_URL}assets/3d/wallet-hero.png`}
              alt=""
              width={140}
              height={140}
              draggable={false}
              className="-mb-1 -ml-4 h-[164px] w-[164px] select-none object-contain mix-blend-multiply"
            />
            <h1 className="mt-4 text-[32px] font-bold leading-[1.26] tracking-[-0.035em] text-ink">
              솔라나를 위한
              <br />
              가장 단순한 지갑
            </h1>
            <p className="mt-4 text-[14.5px] leading-[1.65] text-muted">
              12단어 시드 문구로 새 지갑을 만들거나
              <br />
              기존 지갑을 그대로 불러옵니다.
            </p>
          </div>

          <div className="mt-auto space-y-1">
            <Button full onClick={startCreate}>
              새 지갑 만들기
            </Button>
            <Button full variant="ghost" onClick={() => setStep('import')}>
              기존 지갑 가져오기
            </Button>
          </div>
        </div>
      )}

      {step === 'backup' && (
        <div className="animate-fade flex flex-1 flex-col px-6 pb-8 pt-4">
          <button
            onClick={() => setStep('start')}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink active:bg-[#E9ECF0]"
            aria-label="뒤로"
          >
            <ArrowLeft size={17} strokeWidth={2} />
          </button>
          <h1 className="mt-7 text-[24px] font-bold tracking-[-0.035em] text-ink">시드 문구</h1>
          <p className="mt-2.5 text-[13.5px] leading-[1.7] text-muted">
            순서대로 안전한 곳에 적어 두세요. 이 12단어만 있으면 어디서든 지갑을 복구할 수 있고,
            잃어버리면 되찾을 수 없습니다.
          </p>

          <div className="mt-6 grid grid-cols-3 gap-2">
            {mnemonicWords(mnemonic).map((word, index) => (
              <div
                key={`${word}-${index}`}
                className="flex items-baseline gap-1.5 rounded-[14px] bg-surface px-3 py-2.5"
              >
                <span className="tnum text-[10px] font-medium text-[#A9AFB9]">{index + 1}</span>
                <span className="text-[13.5px] font-semibold tracking-[-0.02em] text-ink">{word}</span>
              </div>
            ))}
          </div>

          <button
            onClick={copyMnemonic}
            className="mt-3 flex items-center gap-1.5 self-start rounded-full px-2.5 py-1.5 text-[12.5px] font-medium text-muted active:bg-surface"
          >
            <Copy size={13} /> 복사
          </button>

          <div className="mt-auto pt-10">
            <button
              onClick={() => setConfirmedBackup((value) => !value)}
              className="flex w-full items-start gap-2.5 pb-5 text-left"
            >
              <span
                className={cx(
                  'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[7px] border transition-colors',
                  confirmedBackup ? 'border-ink bg-ink text-white' : 'border-[#DCE0E6] bg-white',
                )}
              >
                {confirmedBackup && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="text-[13px] leading-snug text-ink2">
                시드 문구를 안전한 곳에 적어 두었습니다.
              </span>
            </button>
            <Button full disabled={!confirmedBackup} onClick={beginWithBackup}>
              다음
            </Button>
          </div>
        </div>
      )}

      {step === 'import' && (
        <div className="animate-fade flex flex-1 flex-col px-6 pb-8 pt-4">
          <button
            onClick={() => setStep('start')}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink active:bg-[#E9ECF0]"
            aria-label="뒤로"
          >
            <ArrowLeft size={17} strokeWidth={2} />
          </button>
          <h1 className="mt-7 text-[24px] font-bold tracking-[-0.035em] text-ink">지갑 가져오기</h1>
          <p className="mt-2.5 text-[13.5px] leading-[1.7] text-muted">
            Phantom, Solflare 등에서 쓰던 시드 문구나 개인키를 그대로 붙여넣으세요.
          </p>

          <div className="mt-6">
            <Segmented
              value={importMode}
              onChange={(next) => {
                setImportMode(next)
                setError(null)
              }}
              options={[
                { value: 'mnemonic', label: '시드 문구' },
                { value: 'secretKey', label: '개인키' },
              ]}
            />
          </div>

          <div className="mt-4">
            <textarea
              value={importText}
              onChange={(event) => {
                setImportText(event.target.value)
                setError(null)
              }}
              placeholder={
                importMode === 'mnemonic'
                  ? 'apple banana cherry ... (12 또는 24단어)'
                  : 'Base58 개인키'
              }
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="h-[136px] w-full resize-none rounded-[18px] bg-surface p-4 text-[14px] leading-relaxed tracking-[-0.01em] text-ink outline-none placeholder:text-[#A9AFB9]"
            />
            <div className="mt-2 flex items-center justify-between px-1 text-[11.5px]">
              <span className={cx(importValid ? 'text-mint' : 'text-muted')}>
                {importMode === 'mnemonic'
                  ? `${words.length} 단어${importValid ? ' · 유효함' : ''}`
                  : importText.trim()
                    ? 'Base58 키'
                    : '입력 대기'}
              </span>
              {error && <span className="text-danger">{error}</span>}
            </div>
          </div>

          <div className="mt-auto pt-8">
            <Button
              full
              disabled={importMode === 'mnemonic' ? !validateMnemonic(importText) : !importValid}
              onClick={beginWithImport}
            >
              다음
            </Button>
          </div>
        </div>
      )}

      {step === 'pin' && (
        <div className="animate-fade flex flex-1 flex-col px-6 pb-6 pt-4">
          <button
            onClick={() => {
              setStep('start')
              setPin('')
              setPinStage('set')
              setFirstPin('')
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink active:bg-[#E9ECF0]"
            aria-label="뒤로"
          >
            <ArrowLeft size={17} strokeWidth={2} />
          </button>

          <div className="mt-12 flex flex-col items-center">
            <h1 className="text-[22px] font-bold tracking-[-0.035em] text-ink">
              {pinStage === 'set' ? 'PIN 설정' : 'PIN 확인'}
            </h1>
            <p className="mt-2 text-center text-[13px] leading-relaxed text-muted">
              {pinStage === 'set'
                ? '앱을 열 때 사용할 6자리 숫자를 정하세요.'
                : '확인을 위해 한 번 더 입력하세요.'}
            </p>
          </div>

          <div className="mt-10">
            <PinDots value={pin} error={pinError} />
            <div className="mt-4 h-5 text-center text-[12.5px] text-danger">{error ?? ''}</div>
          </div>

          <div className="mt-auto pt-4">
            <Keypad
              value={pin}
              onChange={(value) => {
                setPin(value)
                if (pinError) setPinError(false)
              }}
              onComplete={handlePin}
              disabled={busy}
            />
            <p className="mt-5 text-center text-[11.5px] leading-relaxed text-[#A9AFB9]">
              PIN은 이 기기를 벗어나지 않습니다. 잊어버리면 복구할 수 없으니 시드 문구를 꼭
              보관하세요.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
