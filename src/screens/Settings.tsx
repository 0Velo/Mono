import { useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Lock,
  ScanFace,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { BrandMark, Segmented } from '../components/ui'
import { Spinner } from '../components/Spinner'
import { showToast } from '../components/Toast'
import {
  DEFAULT_RPC,
  RPC_EXAMPLE,
  explorerAddress,
  looksLikeRpc,
  rpcHostLabel,
  type NetworkId,
} from '../lib/rpc'
import { saveBackupFile } from '../lib/backup'
import { useWallet, type WalletMeta } from '../state/WalletProvider'
import { cx, shortAddress } from '../lib/format'

interface SettingsProps {
  meta: WalletMeta
  onChangeNetwork: (network: NetworkId) => void
  onSaveRpc: (network: NetworkId, value: string) => void
  onAutoLockChange: (minutes: number) => void
  onBackup: () => void
  onReset: () => void
  onLock: () => void
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="px-5 pb-2.5 text-[12px] font-medium text-muted">{title}</h2>
      <div className="mx-5 overflow-hidden rounded-[20px] bg-surface">{children}</div>
    </section>
  )
}

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={onChange}
      className={cx(
        'relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200',
        value ? 'bg-mint' : 'bg-[#DFE3E9]',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(13,14,18,0.18)] transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
          value ? 'translate-x-[21px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  )
}

const AUTO_LOCK_OPTIONS = [
  { value: '1', label: '1분' },
  { value: '5', label: '5분' },
  { value: '30', label: '30분' },
  { value: '0', label: '끔' },
]

export function Settings({
  meta,
  onChangeNetwork,
  onSaveRpc,
  onAutoLockChange,
  onBackup,
  onReset,
  onLock,
}: SettingsProps) {
  const { vault, biometricAvailable, biometricEnabled, biometricCreatedAt, enrolBiometric, disableBiometric, biometricError } =
    useWallet()
  const [rpcInput, setRpcInput] = useState(meta.rpc[meta.network] ?? '')
  const [copied, setCopied] = useState(false)
  const [bioBusy, setBioBusy] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    setRpcInput(meta.rpc[meta.network] ?? '')
  }, [meta.network, meta.rpc])

  const dirty = (meta.rpc[meta.network] ?? '') !== rpcInput
  const valid = !rpcInput.trim() || looksLikeRpc(rpcInput)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meta.address)
      setCopied(true)
      showToast('주소를 복사했습니다')
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      showToast('복사할 수 없습니다')
    }
  }

  const copyExample = async () => {
    try {
      await navigator.clipboard.writeText(RPC_EXAMPLE[meta.network])
      showToast('예시 주소를 복사했습니다')
    } catch {
      showToast('복사할 수 없습니다')
    }
  }

  const toggleBiometric = async () => {
    if (bioBusy) return
    if (biometricEnabled) {
      disableBiometric()
      showToast('Face ID 잠금 해제를 껐습니다')
      return
    }
    setBioBusy(true)
    try {
      await enrolBiometric()
      showToast('Face ID를 등록했습니다')
    } catch {
      /* the provider stores a readable reason */
    } finally {
      setBioBusy(false)
    }
  }

  const exportBackup = async () => {
    if (!vault || exporting) return
    setExporting(true)
    try {
      const result = await saveBackupFile(vault, meta.address)
      showToast(
        result === 'shared'
          ? '공유 시트에서 파일 앱 또는 iCloud Drive를 고르세요'
          : '백업 파일을 저장했습니다',
      )
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        showToast('백업 파일을 저장하지 못했습니다')
      }
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="animate-fade flex flex-1 flex-col pb-6">
      <div className="px-5" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 22px)' }}>
        <h1 className="text-[22px] font-bold tracking-[-0.035em] text-ink">설정</h1>
      </div>

      <div className="mx-5 mt-5 flex items-center gap-3.5 rounded-[20px] bg-surface px-4 py-4">
        <BrandMark size={38} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold tracking-[-0.02em] text-ink">내 지갑</div>
          <div className="mt-1 font-mono text-[11.5px] text-muted tnum">
            {shortAddress(meta.address, 6)}
          </div>
        </div>
        <button
          onClick={copy}
          aria-label="주소 복사"
          className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-ink"
        >
          {copied ? <Check size={14} className="text-mint" /> : <Copy size={14} />}
        </button>
      </div>

      <div className="mx-5 mt-2.5 flex justify-end">
        <a
          href={explorerAddress(meta.address, meta.network)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[11.5px] text-muted active:opacity-60"
        >
          Solscan에서 보기 <ExternalLink size={11} />
        </a>
      </div>

      <Group title="네트워크">
        <div className="px-4 pb-1 pt-4">
          <Segmented
            value={meta.network}
            onChange={(next) => onChangeNetwork(next)}
            options={[
              { value: 'mainnet', label: 'Mainnet' },
              { value: 'devnet', label: 'Devnet' },
            ]}
          />
        </div>
        <div className="px-4 pb-4 pt-4">
          <div className="flex items-center justify-between">
            <div className="text-[11.5px] font-medium text-muted">RPC 엔드포인트</div>
            <div className="tnum text-[11px] text-[#A9AFB9]">
              현재 {rpcHostLabel(meta.network, meta.rpc[meta.network])}
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={rpcInput}
              onChange={(event) => setRpcInput(event.target.value)}
              placeholder={`https://${meta.network}.helius-rpc.com/?api-key=…`}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="url"
              className={cx(
                'min-w-0 flex-1 rounded-[12px] bg-white px-3 py-2.5 text-[12px] text-ink outline-none transition-shadow placeholder:text-[#AEB4BE]',
                valid ? 'focus:shadow-[0_0_0_2px_rgba(13,14,18,0.06)]' : 'shadow-[0_0_0_2px_rgba(239,68,68,0.35)]',
              )}
            />
            <button
              onClick={() => {
                onSaveRpc(meta.network, rpcInput.trim())
                showToast(rpcInput.trim() ? 'RPC를 저장했습니다' : '기본 RPC로 되돌렸습니다')
              }}
              disabled={!dirty || !valid}
              className={cx(
                'press shrink-0 rounded-full px-4 text-[12.5px] font-semibold',
                dirty && valid ? 'bg-ink text-white' : 'text-[#B7BDC6]',
              )}
            >
              저장
            </button>
          </div>
          {!valid && (
            <p className="mt-1.5 text-[11px] text-danger">https:// 로 시작하는 주소를 넣어 주세요.</p>
          )}

          <div className="mt-3 rounded-[14px] bg-white p-3">
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} className="text-mint" />
              <span className="text-[12px] font-semibold text-ink">Helius 무료 티어</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-[1.65] text-muted">
              helius.dev에서 무료 키를 만들고, 아래 형식의 주소를 그대로 붙여넣으면 됩니다.
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-[10px] bg-surface px-2.5 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink2">
                {RPC_EXAMPLE[meta.network]}
              </code>
              <button
                onClick={copyExample}
                aria-label="예시 RPC 주소 복사"
                className="press flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-muted"
              >
                <Copy size={11} />
              </button>
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <a
                href="https://dashboard.helius.dev/api-keys"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] font-semibold text-ink active:opacity-60"
              >
                Helius 키 만들기 <ExternalLink size={10} />
              </a>
              <a
                href="https://dashboard.quicknode.com/endpoints"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] font-medium text-muted active:opacity-60"
              >
                QuickNode <ExternalLink size={10} />
              </a>
            </div>
          </div>

          <p className="mt-2.5 text-[11px] leading-relaxed text-[#A9AFB9]">
            비워 두면 공용 RPC({DEFAULT_RPC[meta.network].replace('https://', '')})를 씁니다. 개인
            RPC를 넣으면 요청 제한과 403 응답을 피할 수 있습니다.
          </p>
        </div>
      </Group>

      <Group title="보안">
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="text-[14.5px] tracking-[-0.02em] text-ink">자동 잠금</span>
          <div className="w-[172px]">
            <Segmented
              value={String(meta.autoLockMinutes)}
              onChange={(next) => onAutoLockChange(Number(next))}
              options={AUTO_LOCK_OPTIONS}
            />
          </div>
        </div>

        <div className="flex items-center gap-2.5 border-t border-[#EBEDF1] px-4 py-3.5">
          <ScanFace size={17} strokeWidth={1.8} className="shrink-0 text-ink" />
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] tracking-[-0.02em] text-ink">Face ID 잠금 해제</div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted">
              {!biometricAvailable
                ? '이 기기에서는 지원되지 않습니다'
                : biometricEnabled
                  ? `등록됨${
                      biometricCreatedAt
                        ? ` · ${new Date(biometricCreatedAt).toLocaleDateString('ko-KR')}`
                        : ''
                    }`
                  : 'PIN 대신 얼굴로 열 수 있습니다'}
            </div>
            {biometricError && (
              <div className="mt-1 text-[10.5px] leading-snug text-danger">{biometricError}</div>
            )}
          </div>
          {biometricAvailable ? (
            bioBusy ? (
              <Spinner size={18} />
            ) : (
              <Toggle value={biometricEnabled} onChange={() => void toggleBiometric()} label="Face ID 잠금 해제" />
            )
          ) : null}
        </div>

        <button
          onClick={onBackup}
          className="flex w-full items-center justify-between border-t border-[#EBEDF1] px-4 py-4 text-left transition-colors active:bg-[#EDEFF3]"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <ShieldCheck size={16} strokeWidth={1.9} />
            시드 문구 보기
          </span>
          <ChevronRight size={16} className="text-[#B7BDC6]" />
        </button>
        <button
          onClick={onLock}
          className="press flex w-full items-center justify-between border-t border-[#EBEDF1] px-4 py-4 text-left active:bg-[#EDEFF3]"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <Lock size={16} strokeWidth={1.9} />
            지금 잠금
          </span>
          <ChevronRight size={16} className="text-[#B7BDC6]" />
        </button>
      </Group>

      <Group title="백업">
        <button
          onClick={() => void exportBackup()}
          className="flex w-full items-center justify-between px-4 py-4 text-left transition-colors active:bg-[#EDEFF3]"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <Download size={16} strokeWidth={1.9} />
            암호화 백업 파일 저장
          </span>
          {exporting ? (
            <Spinner size={15} />
          ) : (
            <ChevronRight size={16} className="text-[#B7BDC6]" />
          )}
        </button>
        <p className="border-t border-[#EBEDF1] px-4 py-3 text-[11px] leading-[1.65] text-[#A9AFB9]">
          PIN으로 암호화된 .json 파일 한 개입니다. 시드 문구가 그대로 들어 있지 않으니 파일 앱이나
          iCloud Drive에 두어도 안전하고, 새 기기에서는 PIN만 입력하면 복원됩니다.
        </p>
        <button
          onClick={onReset}
          className="flex w-full items-center justify-between border-t border-[#EBEDF1] px-4 py-4 text-left transition-colors active:bg-[#EDEFF3]"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-danger">
            <Trash2 size={16} strokeWidth={1.9} />
            지갑 초기화
          </span>
          <ChevronRight size={16} className="text-[#E8C4C4]" />
        </button>
      </Group>

      <p className="mx-5 mt-8 text-[11.5px] leading-[1.75] text-[#A9AFB9]">
        시드 문구와 개인키는 PIN으로 암호화되어 이 기기의 저장소에만 남습니다. 서버로 전송되지
        않으며, PIN을 잊으면 복구할 수 없습니다.
      </p>

      <div className="mt-6 flex flex-col items-center gap-1 pb-2 text-[11px] text-[#A9AFB9]">
        <span>Sol Wallet 1.1.0</span>
        <span className="tnum">{meta.network === 'mainnet' ? 'Mainnet' : 'Devnet'}</span>
      </div>
    </div>
  )
}
