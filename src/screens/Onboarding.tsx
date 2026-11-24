import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Copy, FileJson, ScanFace, Upload } from 'lucide-react'
import { MonoMark, Segmented } from '../components/ui'
import { Button } from '../components/Button'
import { Keypad, PinDots } from '../components/Keypad'
import { Spinner } from '../components/Spinner'
import { showToast } from '../components/Toast'
import { useWallet } from '../state/WalletProvider'
import { loadKeys, prefetchKeys } from '../lib/keys'
import { hasMnemonicShape, looksLikeSecretKey, mnemonicWords, normalizeMnemonic } from '../lib/words'
import { parseBackupFile, type ParsedBackup } from '../lib/backup'
import type { SecretPayload } from '../lib/vault'
import { cx, shortAddress } from '../lib/format'

type Step = 'start' | 'backup' | 'import' | 'pin' | 'restore'
type ImportMode = 'mnemonic' | 'secretKey' | 'backup'

export function Onboarding() {
  const { createWallet, restoreBackup, biometricAvailable, enrolBiometric } = useWallet()
  const [step, setStep] = useState<Step>('start')
  const [mnemonic, setMnemonic] = useState('')
  const [importMode, setImportMode] = useState<ImportMode>('mnemonic')
  const [importText, setImportText] = useState('')
  const [importValid, setImportValid] = useState(false)
  const [confirmedBackup, setConfirmedBackup] = useState(false)
  const [payload, setPayload] = useState<SecretPayload | null>(null)
  const [pin, setPin] = useState('')
  const [pinStage, setPinStage] = useState<'set' | 'confirm'>('set')
  const [firstPin, setFirstPin] = useState('')
  const [pinError, setPinError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [faceIdWanted, setFaceIdWanted] = useState(false)
  const [backup, setBackup] = useState<ParsedBackup | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  const words = useMemo(() => mnemonicWords(importText), [importText])

  // The seed/key module is a lazy chunk; warm it while people read the screen.
  useEffect(() => {
    const timer = window.setTimeout(prefetchKeys, 400)
    return () => window.clearTimeout(timer)
  }, [])

  // Mnemonic checksum needs the wordlist, so it runs slightly deferred.
  useEffect(() => {
    if (importMode !== 'mnemonic') return
    if (!hasMnemonicShape(importText)) {
      setImportValid(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void loadKeys().then((keys) => {
        if (!cancelled) setImportValid(keys.validateMnemonic(importText))
      })
    }, 140)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [importText, importMode])

  useEffect(() => {
    if (importMode !== 'secretKey') return
    setImportValid(looksLikeSecretKey(importText))
  }, [importText, importMode])

  useEffect(() => {
    if (biometricAvailable) setFaceIdWanted(true)
  }, [biometricAvailable])

  const startCreate = async () => {
    if (busy) return
    setBusy(true)
    try {
      const keys = await loadKeys()
      const next = keys.generateMnemonic(12)
      setMnemonic(next)
      setPayload(keys.secretPayloadFromMnemonic(next))
      setStep('backup')
    } catch {
      setError('시드 문구를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy(false)
    }
  }

  const beginWithBackup = () => {
    setPayload({ kind: 'mnemonic', mnemonic, path: "m/44'/501'/0'/0'" })
    setStep('pin')
  }

  const beginWithImport = async () => {
    setError(null)
    setBusy(true)
    try {
      const keys = await loadKeys()
      if (importMode === 'mnemonic') {
        if (!keys.validateMnemonic(importText)) {
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
      setStep('pin')
    } finally {
      setBusy(false)
    }
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
      if (faceIdWanted && biometricAvailable) {
        try {
          await enrolBiometric(payload)
          showToast('Face ID를 등록했습니다')
        } catch {
          showToast('Face ID 등록을 건너뜁니다')
        }
      }
      await createWallet(payload, value)
    } catch (err) {
      setError((err as Error)?.message || '지갑을 만들지 못했습니다.')
      setPin('')
      setPinStage('set')
      setFirstPin('')
      setBusy(false)
    }
  }

  const handleRestorePin = async (value: string) => {
    if (!backup || busy) return
    setBusy(true)
    setRestoreError(null)
    try {
      await restoreBackup(backup.vault, value, backup.address)
    } catch (err) {
      const name = (err as { name?: string })?.name
      setRestoreError(
        name === 'InvalidPinError'
          ? 'PIN이 올바르지 않습니다.'
          : (err as Error)?.message || '백업을 복원하지 못했습니다.',
      )
      setPin('')
      setPinError(true)
      window.setTimeout(() => setPinError(false), 460)
    } finally {
      setBusy(false)
    }
  }

  const pickBackupFile = async (file: File | null) => {
    if (!file) return
    setError(null)
    try {
      const text = await file.text()
      const parsed = parseBackupFile(text)
      setBackup(parsed)
      setPin('')
      setRestoreError(null)
      setStep('restore')
    } catch (err) {
      setError((err as Error)?.message || '백업 파일을 읽지 못했습니다.')
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

  const backButton = (onClick: () => void) => (
    <button
      onClick={onClick}
      className="press flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink"
      aria-label="뒤로"
    >
      <ArrowLeft size={17} strokeWidth={2} />
    </button>
  )

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[430px] flex-col bg-base">
      <div className="safe-top" />

      {step === 'start' && (
        <div className="animate-fade flex flex-1 flex-col px-6 pb-10 pt-8">
          <div className="flex flex-1 flex-col justify-center pb-4">
            <div className="animate-rise -ml-2 flex items-center">
              <MonoMark size={172} />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[13px] font-semibold uppercase tracking-[0.28em] text-ink">
                Mono
              </span>
              <span className="h-px w-6 bg-line2" />
              <span className="text-[11px] font-medium text-faint">Solana Wallet</span>
            </div>
            <h1 className="mt-3 text-[32px] font-bold leading-[1.26] tracking-[-0.035em] text-ink">
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
            <Button full onClick={() => void startCreate()} loading={busy}>
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
          {backButton(() => setStep('start'))}
          <h1 className="mt-7 text-[24px] font-bold tracking-[-0.035em] text-ink">시드 문구</h1>
          <p className="mt-2.5 text-[13.5px] leading-[1.7] text-muted">
            순서대로 안전한 곳에 적어 두세요. 이 12단어만 있으면 어디서든 지갑을 복구할 수 있고,
            잃어버리면 되찾을 수 없습니다.
          </p>

          <div className="mt-6 grid grid-cols-3 gap-2">
            {mnemonicWords(mnemonic).map((word, index) => (
              <div
                key={`${word}-${index}`}
                className="animate-rise flex items-baseline gap-1.5 rounded-[14px] bg-surface px-3 py-2.5"
                style={{ animationDelay: `${Math.min(index * 18, 220)}ms` }}
              >
                <span className="tnum text-[10px] font-medium text-faint">{index + 1}</span>
                <span className="text-[13.5px] font-semibold tracking-[-0.02em] text-ink">
                  {word}
                </span>
              </div>
            ))}
          </div>

          <button
            onClick={copyMnemonic}
            className="press mt-3 flex items-center gap-1.5 self-start rounded-full px-2.5 py-1.5 text-[12.5px] font-medium text-muted"
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
                  'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[7px] border transition-all duration-200',
                  confirmedBackup ? 'border-ink bg-ink text-onInk' : 'border-line bg-card',
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
          {backButton(() => setStep('start'))}
          <h1 className="mt-7 text-[24px] font-bold tracking-[-0.035em] text-ink">지갑 가져오기</h1>
          <p className="mt-2.5 text-[13.5px] leading-[1.7] text-muted">
            시드 문구, 개인키, 또는 이 앱에서 저장한 암호화 백업 파일로 복원할 수 있습니다.
          </p>

          <div className="mt-6">
            <Segmented
              value={importMode}
              onChange={(next) => {
                setImportMode(next)
                setError(null)
                setImportValid(false)
              }}
              options={[
                { value: 'mnemonic', label: '시드 문구' },
                { value: 'secretKey', label: '개인키' },
                { value: 'backup', label: '백업 파일' },
              ]}
            />
          </div>

          {importMode !== 'backup' && (
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
                className="h-[136px] w-full resize-none rounded-[18px] bg-surface p-4 text-[14px] leading-relaxed tracking-[-0.01em] text-ink outline-none transition-shadow focus:shadow-[0_0_0_2px_rgba(13,14,18,0.06)] placeholder:text-faint"
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
          )}

          {importMode === 'backup' && (
            <div className="mt-4">
              <label className="press flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[18px] border border-dashed border-line bg-surface px-4 py-8 text-center">
                <FileJson size={22} strokeWidth={1.7} className="text-muted" />
                <span className="text-[13.5px] font-semibold text-ink">
                  백업 파일 선택 (.json)
                </span>
                <span className="text-[11.5px] leading-relaxed text-muted">
                  암호화 백업 파일에는 암호문만 들어 있습니다.
                  <br />
                  복원할 때 지갑 PIN이 필요합니다.
                </span>
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => void pickBackupFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <p className="mt-2.5 flex items-start gap-1.5 px-1 text-[11.5px] leading-relaxed text-faint">
                <Upload size={12} className="mt-0.5 shrink-0" />
                아이폰 파일 앱 → iCloud Drive에 저장해 둔 백업을 그대로 고르면 됩니다.
              </p>
              {error && <p className="mt-2 px-1 text-[11.5px] text-danger">{error}</p>}
            </div>
          )}

          {importMode !== 'backup' && (
            <div className="mt-auto pt-8">
              <Button full disabled={!importValid || busy} onClick={() => void beginWithImport()}>
                다음
              </Button>
            </div>
          )}
        </div>
      )}

      {step === 'pin' && (
        <div className="animate-fade flex flex-1 flex-col px-6 pb-6 pt-4">
          {backButton(() => {
            setStep('start')
            setPin('')
            setPinStage('set')
            setFirstPin('')
          })}

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

          <div className="mt-9">
            <PinDots value={pin} error={pinError} />
            <div className="mt-4 h-5 text-center text-[12.5px] text-danger">{error ?? ''}</div>
          </div>

          <div className="mt-auto pt-2">
            <Keypad
              value={pin}
              onChange={(value) => {
                setPin(value)
                if (pinError) setPinError(false)
              }}
              onComplete={handlePin}
              disabled={busy}
              compact
            />

            {biometricAvailable && (
              <button
                onClick={() => setFaceIdWanted((value) => !value)}
                className="mt-4 flex w-full items-center gap-2.5 rounded-[16px] bg-surface px-4 py-3 text-left"
              >
                <ScanFace size={17} strokeWidth={1.8} className="shrink-0 text-ink" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-ink">
                    Face ID로 잠금 해제
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                    다음부터 PIN 대신 얼굴로 열 수 있습니다.
                  </span>
                </span>
                <span
                  className={cx(
                    'relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200',
                    faceIdWanted ? 'bg-mint' : 'bg-switch',
                  )}
                >
                  <span
                    className={cx(
                      'absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-transform duration-200',
                      faceIdWanted ? 'translate-x-[21px]' : 'translate-x-[3px]',
                    )}
                  />
                </span>
              </button>
            )}

            <p className="mt-4 text-center text-[11.5px] leading-relaxed text-faint">
              PIN은 이 기기를 벗어나지 않습니다. 잊어버리면 복구할 수 없으니 시드 문구를 꼭
              보관하세요.
            </p>
          </div>
        </div>
      )}

      {step === 'restore' && backup && (
        <div className="animate-fade flex flex-1 flex-col px-6 pb-6 pt-4">
          {backButton(() => {
            setStep('import')
            setBackup(null)
            setPin('')
            setRestoreError(null)
          })}

          <div className="mt-10 flex flex-col items-center">
            <div className="flex h-[54px] w-[54px] items-center justify-center rounded-[18px] bg-surface">
              <FileJson size={24} strokeWidth={1.7} className="text-ink" />
            </div>
            <h1 className="mt-5 text-[21px] font-bold tracking-[-0.035em] text-ink">
              백업 파일 확인
            </h1>
            <p className="mt-2 text-center text-[13px] leading-relaxed text-muted">
              지갑 PIN 6자리를 입력하면 바로 복원됩니다.
            </p>
          </div>

          <div className="mt-6 rounded-[18px] bg-surface px-4 py-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted">지갑 주소</span>
              <span className="tnum text-[12.5px] font-medium text-ink">
                {backup.address ? shortAddress(backup.address, 5) : '파일에 없음'}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[12px] text-muted">백업 시각</span>
              <span className="tnum text-[12.5px] font-medium text-ink">
                {backup.exportedAt
                  ? new Date(backup.exportedAt).toLocaleDateString('ko-KR')
                  : '알 수 없음'}
              </span>
            </div>
          </div>

          <div className="mt-7">
            <PinDots value={pin} error={pinError} />
            <div className="mt-4 h-5 text-center text-[12.5px] text-danger">
              {restoreError ?? ''}
            </div>
          </div>

          <div className="mt-auto pt-2">
            <Keypad
              value={pin}
              onChange={(value) => {
                setPin(value)
                if (restoreError) setRestoreError(null)
              }}
              onComplete={handleRestorePin}
              disabled={busy}
              compact
            />
            {busy && (
              <div className="mt-3 flex items-center justify-center gap-2 text-[12px] text-muted">
                <Spinner size={14} /> 복원 중…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
