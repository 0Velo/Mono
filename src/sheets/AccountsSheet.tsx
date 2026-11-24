import { useState } from 'react'
import { Check, Pencil, Plus, X } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { useWallet } from '../state/WalletProvider'
import { showToast } from '../components/Toast'
import { cx, shortAddress } from '../lib/format'
import { MonoMark } from '../components/ui'

interface AccountsSheetProps {
  open: boolean
  onClose: () => void
  onSwitched: () => void
}

/**
 * Accounts derived from the same seed phrase. Every account is a real Solana
 * address on the standard Phantom path, so any wallet that imports the phrase
 * shows the same list in the same order.
 */
export function AccountsSheet({ open, onClose, onSwitched }: AccountsSheetProps) {
  const { accounts, activeIndex, switchAccount, renameAccount, meta } = useWallet()
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const nextIndex = accounts.length ? Math.max(...accounts.map((account) => account.index)) + 1 : 1

  const choose = async (index: number) => {
    if (index === activeIndex) {
      onClose()
      return
    }
    setBusy(true)
    try {
      await switchAccount(index)
      onSwitched()
      showToast('계정을 바꿨습니다')
      onClose()
    } catch {
      showToast('계정을 바꾸지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    setBusy(true)
    try {
      await switchAccount(nextIndex)
      onSwitched()
      showToast(`계정 ${nextIndex + 1}을 추가했습니다`)
      onClose()
    } catch {
      showToast('계정을 추가하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="계정" subtitle="같은 시드 문구에서 파생된 계정">
      <div className="mt-1 space-y-2">
        {accounts.map((account) => {
          const active = account.index === activeIndex
          const isEditing = editing === account.index
          return (
            <div
              key={account.index}
              className={cx(
                'flex items-center gap-3 rounded-[18px] px-4 py-3.5',
                active ? 'bg-surface ring-1 ring-ink/10' : 'bg-surface',
              )}
            >
              <MonoMark size={34} />
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value.slice(0, 14))}
                      className="min-w-0 flex-1 rounded-[10px] bg-card px-2 py-1 text-[13px] font-semibold text-ink outline-none"
                      autoFocus
                    />
                    <button
                      onClick={() => {
                        renameAccount(account.index, draft)
                        setEditing(null)
                      }}
                      aria-label="이름 저장"
                      className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-onInk"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      aria-label="취소"
                      className="flex h-6 w-6 items-center justify-center rounded-full text-muted"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => choose(account.index)}
                    className="block w-full text-left"
                  >
                    <span className="text-[14px] font-semibold tracking-[-0.02em] text-ink">
                      {account.name}
                    </span>
                  </button>
                )}
                <div className="mt-0.5 font-mono text-[11px] text-muted tnum">
                  {shortAddress(account.address, 6)}
                </div>
              </div>

              {!isEditing && (
                <button
                  onClick={() => {
                    setEditing(account.index)
                    setDraft(account.name)
                  }}
                  aria-label="이름 바꾸기"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted active:opacity-60"
                >
                  <Pencil size={13} />
                </button>
              )}

              {active && !isEditing && <Check size={16} className="text-mint" />}
            </div>
          )
        })}
      </div>

      <button
        onClick={() => void add()}
        disabled={busy}
        className="mt-3 flex w-full items-center gap-2 rounded-[18px] bg-surface px-4 py-3.5 text-left active:bg-press disabled:opacity-50"
      >
        <Plus size={15} className="text-ink" />
        <span className="text-[13px] font-semibold text-ink">계정 추가</span>
        <span className="ml-auto text-[11px] text-faint">m/44'/501'/{nextIndex}'/0'</span>
      </button>

      <p className="mt-4 px-1 text-[10.5px] leading-[1.7] text-faint">
        계정은 모두 {meta ? '같은 시드 문구' : '시드 문구'}에서 파생됩니다. 시드 문구 하나만
        백업해 두면 이 목록 전체를 복원할 수 있습니다.
      </p>
    </Sheet>
  )
}
