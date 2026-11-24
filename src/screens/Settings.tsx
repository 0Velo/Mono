import { useEffect, useState } from 'react'
import { Check, ChevronRight, Copy, Download, ExternalLink, Lock, ShieldCheck, Trash2 } from 'lucide-react'
import { BrandMark, Segmented } from '../components/ui'
import { showToast } from '../components/Toast'
import { DEFAULT_RPC, explorerAddress, type NetworkId } from '../lib/rpc'
import type { WalletMeta } from '../state/WalletProvider'
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
  const [rpcInput, setRpcInput] = useState(meta.rpc[meta.network] ?? '')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setRpcInput(meta.rpc[meta.network] ?? '')
  }, [meta.network, meta.rpc])

  const dirty = (meta.rpc[meta.network] ?? '') !== rpcInput

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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-ink active:bg-[#F0F2F5]"
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
          <div className="text-[11.5px] font-medium text-muted">RPC 엔드포인트</div>
          <div className="mt-2 flex gap-2">
            <input
              value={rpcInput}
              onChange={(event) => setRpcInput(event.target.value)}
              placeholder={DEFAULT_RPC[meta.network]}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="min-w-0 flex-1 rounded-[12px] bg-white px-3 py-2.5 text-[12px] text-ink outline-none placeholder:text-[#AEB4BE]"
            />
            <button
              onClick={() => {
                onSaveRpc(meta.network, rpcInput.trim())
                showToast('RPC를 저장했습니다')
              }}
              disabled={!dirty}
              className={cx(
                'shrink-0 rounded-full px-4 text-[12.5px] font-semibold',
                dirty ? 'bg-ink text-white' : 'text-[#B7BDC6]',
              )}
            >
              저장
            </button>
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-[#A9AFB9]">
            Helius, QuickNode 같은 개인 RPC를 넣으면 공용 RPC의 요청 제한을 피할 수 있습니다.
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
        <button
          onClick={onBackup}
          className="flex w-full items-center justify-between border-t border-[#EBEDF1] px-4 py-4 text-left active:bg-[#EDEFF3]"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <ShieldCheck size={16} strokeWidth={1.9} />
            시드 문구 보기
          </span>
          <ChevronRight size={16} className="text-[#B7BDC6]" />
        </button>
        <button
          onClick={onLock}
          className="flex w-full items-center justify-between border-t border-[#EBEDF1] px-4 py-4 text-left active:bg-[#EDEFF3]"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <Lock size={16} strokeWidth={1.9} />
            지금 잠금
          </span>
          <ChevronRight size={16} className="text-[#B7BDC6]" />
        </button>
      </Group>

      <Group title="데이터">
        <button
          onClick={onBackup}
          className="flex w-full items-center justify-between px-4 py-4 text-left active:bg-[#EDEFF3]"
        >
          <span className="flex items-center gap-2.5 text-[14.5px] tracking-[-0.02em] text-ink">
            <Download size={16} strokeWidth={1.9} />
            지갑 백업
          </span>
          <ChevronRight size={16} className="text-[#B7BDC6]" />
        </button>
        <button
          onClick={onReset}
          className="flex w-full items-center justify-between border-t border-[#EBEDF1] px-4 py-4 text-left active:bg-[#EDEFF3]"
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
        <span>Sol Wallet 1.0.0</span>
        <span className="tnum">
          {meta.network === 'mainnet' ? 'Mainnet' : 'Devnet'}
        </span>
      </div>
    </div>
  )
}
