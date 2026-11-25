import { useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Lock,
  Moon,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  BookUser,
} from 'lucide-react'
import { MonoMark, Segmented } from '../components/ui'
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
import { useTheme, type ThemePref } from '../lib/theme'
import { useAddressBook } from '../lib/addressBook'
import { cx, shortAddress } from '../lib/format'

interface SettingsProps {
  meta: WalletMeta
  onChangeNetwork: (network: NetworkId) => void
  onSaveRpc: (network: NetworkId, value: string) => void
  onAutoLockChange: (minutes: number) => void
  onBackup: () => void
  onReset: () => void
  onLock: () => void
  onAddressBook: () => void
  onAccounts: () => void
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="px-5 pb-2.5 text-[12px] font-medium text-muted">{title}</h2>
      <div className="mx-5 overflow-hidden rounded-[20px] bg-surface">{children}</div>
    </section>
  )
}

const AUTO_LOCK_OPTIONS = [
  { value: '1', label: '1분' },
  { value: '5', label: '5분' },
  { value: '30', label: '30분' },
  { value: '0', label: '끔' },
]

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
  { value: 'system', label: '시스템' },
]

export function Settings({
  meta,
  onChangeNetwork,
  onSaveRpc,
  onAutoLockChange,
  onBackup,
  onReset,
  onLock,
  onAddressBook,
  onAccounts,
}: SettingsProps) {
  const {
    vault,
    accounts,
    activeIndex,
    activeAccount,
  } = useWallet()
  const { pref: themePref, setTheme } = useTheme()
  const book = useAddressBook()
  const [rpcInput, setRpcInput] = useState(meta.rpc[meta.network] ?? '')
  const [copied, setCopied] = useState(false)
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

  const exportBackup = async () => {
    if (!vault || exporting) return
    setExporting(true)
    try {
      const result = await saveBackupFile(vault, meta.address, {
        activeIndex,
        accountIndices: accounts.map((account) => account.index),
        accountNames: meta.accountNames,
      })
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

      <div className="mx-5 mt-5 flex w-[calc(100%-40px)] items-center gap-3.5 rounded-[20px] bg-card px-3.5 py-3.5 ring-1 ring-line">
        <button
          onClick={onAccounts}
          className="press flex min-w-0 flex-1 items-center gap-3.5 text-left"
          aria-label="계정 관리"
        >
          <MonoMark size={46} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[14.5px] font-semibold tracking-[-0.02em] text-ink">
                {activeAccount?.name ?? meta.name}
              </span>
              {accounts.length > 1 && (
                <span className="rounded-full bg-surface px-1.5 py-[1px] text-[9.5px] font-semibold text-muted">
                  계정 {activeIndex + 1}
                </span>
              )}
            </div>
            <div className="mt-1 font-mono text-[11.5px] text-muted tnum">
              {shortAddress(meta.address, 6)}
            </div>
          </div>
          <ChevronRight size={15} className="shrink-0 text-faint2" />
        </button>
        <button
          onClick={() => void copy()}
          aria-label="주소 복사"
          className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface text-ink"
        >
          {copied ? <Check size={14} className="text-mint" /> : <Copy size={14} />}
        </button>
      </div>

      <div className="mx-5 mt-2.5 flex items-center justify-between">
        <button
          onClick={onAddressBook}
          className="flex items-center gap-1 text-[11.5px] font-medium text-muted active:opacity-60"
        >
          <BookUser size={12} /> 주소록 {book.length > 0 ? book.length : ''}
          <ChevronRight size={11} />
        </button>
        <a
          href={explorerAddress(meta.address, meta.network)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[11.5px] text-muted active:opacity-60"
        >
          Solscan에서 보기 <ExternalLink size={11} />
        </a>
      </div>

      <Group title="디스플레이">
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <Moon size={16} strokeWidth={1.9} /> 테마
          </span>
          <div className="w-[186px]">
            <Segmented value={themePref} onChange={setTheme} options={THEME_OPTIONS} compact />
          </div>
        </div>
      </Group>

      <Group title="지갑">
        <button
          onClick={onAccounts}
          className="flex w-full items-center justify-between px-4 py-4 text-left transition-colors active:bg-press"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <UserRound size={16} strokeWidth={1.9} /> 계정
          </span>
          <span className="flex items-center gap-1 text-[13px] text-muted">
            {accounts.length}개 <ChevronRight size={16} className="text-faint2" />
          </span>
        </button>
        <button
          onClick={onAddressBook}
          className="flex w-full items-center justify-between border-t border-line2 px-4 py-4 text-left transition-colors active:bg-press"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <BookUser size={16} strokeWidth={1.9} /> 주소록
          </span>
          <span className="flex items-center gap-1 text-[13px] text-muted">
            {book.length}개 <ChevronRight size={16} className="text-faint2" />
          </span>
        </button>
      </Group>

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
            <div className="tnum text-[11px] text-faint">
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
                'min-w-0 flex-1 rounded-[12px] bg-card px-3 py-2.5 text-[12px] text-ink outline-none transition-shadow placeholder:text-faint',
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
                dirty && valid ? 'bg-ink text-onInk' : 'text-faint2',
              )}
            >
              저장
            </button>
          </div>
          {!valid && (
            <p className="mt-1.5 text-[11px] text-danger">https:// 로 시작하는 주소를 넣어 주세요.</p>
          )}

          <div className="mt-3 rounded-[14px] bg-card p-3">
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
                className="press flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-card text-muted"
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

          <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
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

        <div className="flex items-center gap-2.5 border-t border-line2 px-4 py-3.5">
          <Lock size={17} strokeWidth={1.8} className="shrink-0 text-ink" />
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] tracking-[-0.02em] text-ink">키 보관 방식</div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted">
              암호화된 볼트는 IndexedDB에, 복호화된 키는 잠금 시 즉시 0으로 덮어씁니다
            </div>
          </div>
        </div>

        <button
          onClick={onBackup}
          className="flex w-full items-center justify-between border-t border-line2 px-4 py-4 text-left transition-colors active:bg-press"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <ShieldCheck size={16} strokeWidth={1.9} />
            시드 문구 보기
          </span>
          <ChevronRight size={16} className="text-faint2" />
        </button>
        <button
          onClick={onLock}
          className="press flex w-full items-center justify-between border-t border-line2 px-4 py-4 text-left active:bg-press"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <Lock size={16} strokeWidth={1.9} />
            지금 잠금
          </span>
          <ChevronRight size={16} className="text-faint2" />
        </button>
      </Group>

      <Group title="백업">
        <button
          onClick={() => void exportBackup()}
          className="flex w-full items-center justify-between px-4 py-4 text-left transition-colors active:bg-press"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <Download size={16} strokeWidth={1.9} />
            암호화 백업 파일 저장
          </span>
          {exporting ? (
            <Spinner size={15} />
          ) : (
            <ChevronRight size={16} className="text-faint2" />
          )}
        </button>
        <p className="border-t border-line2 px-4 py-3 text-[11px] leading-[1.65] text-faint">
          PIN으로 암호화된 .json 파일 한 개입니다. 시드 문구가 그대로 들어 있지 않으니 파일 앱이나
          iCloud Drive에 두어도 안전하고, 새 기기에서는 PIN만 입력하면 복원됩니다.
        </p>
        <button
          onClick={onReset}
          className="flex w-full items-center justify-between border-t border-line2 px-4 py-4 text-left transition-colors active:bg-press"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-danger">
            <Trash2 size={16} strokeWidth={1.9} />
            지갑 초기화
          </span>
          <ChevronRight size={16} className="text-danger/40" />
        </button>
      </Group>

      <p className="mx-5 mt-8 text-[11.5px] leading-[1.75] text-faint">
        시드 문구와 개인키는 PIN으로 암호화되어 이 기기의 저장소에만 남습니다. 서버로 전송되지
        않으며, PIN을 잊으면 복구할 수 없습니다.
      </p>

      <div className="mt-6 flex flex-col items-center gap-1 pb-2 text-[11px] text-faint">
        <span>Mono 2.0.0</span>
        <span className="tnum">
          Mono · v10 · {meta.network === 'mainnet' ? 'Mainnet' : 'Devnet'}
        </span>
      </div>
    </div>
  )
}
