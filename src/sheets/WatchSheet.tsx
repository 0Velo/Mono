import { useState } from 'react'
import { Bell, BellOff, Fish, Pencil, Plus, Trash2 } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { showToast } from '../components/Toast'
import { cx, shortAddress } from '../lib/format'
import type { NetworkId } from '../lib/rpc'
import {
  MAX_WATCH_LABEL,
  MAX_WATCH_WALLETS,
  addWatch,
  looksLikeSolanaAddress,
  removeWatch,
  updateWatch,
  useWatchWallets,
  type WatchAddFailure,
} from '../lib/watchWallets'

interface WatchSheetProps {
  open: boolean
  onClose: () => void
  network: NetworkId
  pushEnabled: boolean
  ownAddress: string
}

function reasonMessage(reason: WatchAddFailure): string {
  switch (reason) {
    case 'label':
      return '별명을 입력하세요'
    case 'address':
      return 'Solana 주소를 확인하세요'
    case 'duplicate':
      return '이미 추적 중인 주소입니다'
    case 'own':
      return '내 지갑은 입출금 알림으로 이미 받습니다'
    case 'full':
      return `고래 지갑은 ${MAX_WATCH_WALLETS}개까지 추적할 수 있습니다`
  }
}

/**
 * 고래(외부) 지갑 관리 — 별명과 공개 주소만 저장한다. 알림은 백그라운드 Web
 * Push를 켠 기기에서만 도착하며, 푸시가 꺼져 있어도 목록은 만들어 둘 수 있다.
 */
export function WatchSheet({ open, onClose, network, pushEnabled, ownAddress }: WatchSheetProps) {
  const watches = useWatchWallets()
  const mainnet = network === 'mainnet'
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')

  const validAddress = looksLikeSolanaAddress(address)
  const canAdd = mainnet && watches.length < MAX_WATCH_WALLETS

  const reset = () => {
    setAdding(false)
    setEditId(null)
    setLabel('')
    setAddress('')
  }

  const commit = () => {
    const result = addWatch(label, address, ownAddress)
    if (!result.ok) {
      showToast(reasonMessage(result.reason))
      return
    }
    showToast(pushEnabled ? '고래 지갑을 추가했습니다' : '추가했습니다 · Web Push를 켜면 알림이 시작됩니다')
    reset()
  }

  const note = !mainnet
    ? '고래 알림은 Mainnet에서만 동작합니다. 설정에서 네트워크를 Mainnet으로 바꾸면 주소를 등록할 수 있습니다.'
    : !pushEnabled
      ? '백그라운드 Web Push를 켜야 앱을 닫아 둔 동안 알림이 도착합니다. 지금 추가해 두면 켤 때 함께 등록됩니다.'
      : '스왑·송금이 감지되면 [별명] 제목으로 알려 줍니다. 공개 주소만 서버에 전달되고 키는 필요 없습니다.'

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="고래 지갑"
      subtitle="외부 지갑의 스왑·송금을 실시간 알림"
      footer={
        adding || editId ? undefined : (
          <Button full variant="secondary" onClick={() => setAdding(true)} disabled={!canAdd}>
            <span className="flex items-center gap-1.5">
              <Plus size={15} /> 고래 지갑 추가
            </span>
          </Button>
        )
      }
    >
      <p className={cx(
        'rounded-[16px] px-3.5 py-3 text-[11px] leading-[1.65]',
        !mainnet ? 'bg-warn/10 text-warn' : pushEnabled ? 'bg-surface text-muted' : 'bg-warn/10 text-warn',
      )}>
        {note}
      </p>

      {adding && (
        <div className="animate-pop mt-3 rounded-[18px] bg-surface p-4">
          <div className="text-[12px] font-medium text-muted">별명</div>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value.slice(0, MAX_WATCH_LABEL))}
            placeholder="예: 고래 1"
            className="mt-1.5 w-full rounded-[12px] bg-card px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-faint"
            autoFocus
          />
          <div className="mt-3 text-[12px] font-medium text-muted">Solana 주소</div>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value.trim())}
            placeholder="추적할 지갑 주소"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className={cx(
              'mt-1.5 w-full rounded-[12px] bg-card px-3 py-2.5 font-mono text-[11.5px] text-ink outline-none placeholder:font-sans placeholder:text-faint',
              address && !validAddress && 'text-danger',
            )}
          />
          <div className="mt-3 flex gap-2">
            <Button full onClick={commit} disabled={!label.trim() || !validAddress}>
              추가
            </Button>
            <Button full variant="ghost" onClick={reset}>
              취소
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 space-y-1">
        {watches.map((entry) => (
          <div key={entry.id} className="py-3">
            {editId === entry.id ? (
              <div className="flex items-center gap-2">
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value.slice(0, MAX_WATCH_LABEL))}
                  maxLength={MAX_WATCH_LABEL}
                  className="min-w-0 flex-1 rounded-[12px] bg-surface px-3 py-2.5 text-[13px] text-ink outline-none"
                  autoFocus
                />
                <button
                  onClick={() => {
                    if (!label.trim()) {
                      showToast('별명을 입력하세요')
                      return
                    }
                    updateWatch(entry.id, { label })
                    reset()
                    showToast('별명을 바꿨습니다')
                  }}
                  className="press rounded-full bg-ink px-3.5 py-2 text-[12px] font-semibold text-onInk"
                >
                  저장
                </button>
                <button onClick={reset} className="press px-1 text-[12px] text-muted">
                  취소
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className={cx(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                  entry.enabled ? 'bg-mintSoft text-mint' : 'bg-surface text-faint',
                )}>
                  <Fish size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold text-ink">{entry.label}</div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-muted">
                    {shortAddress(entry.address, 6)}
                  </div>
                </div>
                <button
                  onClick={() => {
                    updateWatch(entry.id, { enabled: !entry.enabled })
                    showToast(entry.enabled ? '알림을 껐습니다' : '알림을 켰습니다')
                  }}
                  aria-pressed={entry.enabled}
                  aria-label={entry.enabled ? '알림 끄기' : '알림 켜기'}
                  className={cx(
                    'press flex h-8 w-8 items-center justify-center rounded-full',
                    entry.enabled ? 'bg-mintSoft text-mint' : 'bg-surface text-faint',
                  )}
                >
                  {entry.enabled ? <Bell size={13} /> : <BellOff size={13} />}
                </button>
                <button
                  onClick={() => {
                    setAdding(false)
                    setEditId(entry.id)
                    setLabel(entry.label)
                    setAddress('')
                  }}
                  aria-label="별명 수정"
                  className="press flex h-8 w-8 items-center justify-center rounded-full text-muted active:opacity-60"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => {
                    removeWatch(entry.id)
                    showToast('고래 지갑에서 삭제했습니다')
                  }}
                  aria-label="삭제"
                  className="press flex h-8 w-8 items-center justify-center rounded-full text-faint active:opacity-60"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
        ))}

        {watches.length === 0 && !adding && (
          <div className="py-8 text-center text-[12px] leading-relaxed text-muted">
            추적 중인 고래 지갑이 없습니다.
            <br />
            주소와 별명을 추가하면 스왑·송금을 알려 드립니다.
          </div>
        )}
      </div>
    </Sheet>
  )
}
