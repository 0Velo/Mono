import { useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { MAX_ACCOUNTS, useWallet } from '../state/WalletProvider'
import { showToast } from '../components/Toast'
import { cx, shortAddress } from '../lib/format'
import { MonoMark } from '../components/ui'

interface AccountsSheetProps {
  open: boolean
  onClose: () => void
}

/**
 * Accounts derived from the same seed phrase. Every account is a real Solana
 * address on the standard Phantom path, so any wallet that imports the phrase
 * shows the same list in the same order. The list is the wallet's own registry
 * (`accountIndices`): nothing here assumes a fixed number of accounts.
 */
export function AccountsSheet({ open, onClose }: AccountsSheetProps) {
  const { accounts, activeIndex, switchAccount, addAccount, removeAccount, renameAccount, meta } =
    useWallet()
  const [editing, setEditing] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const used = new Set(accounts.map((account) => account.index))
  let nextIndex = 1
  while (used.has(nextIndex) && nextIndex < MAX_ACCOUNTS) nextIndex += 1
  const full = accounts.length >= MAX_ACCOUNTS

  const choose = async (index: number) => {
    if (index === activeIndex) {
      onClose()
      return
    }
    setBusy(true)
    try {
      await switchAccount(index)
      showToast('계정을 바꿨습니다')
      onClose()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '계정을 바꾸지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    setBusy(true)
    try {
      const index = await addAccount()
      showToast(`계정 ${index + 1}을 추가했습니다`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '계정을 추가하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (index: number) => {
    setBusy(true)
    try {
      await removeAccount(index)
      setDeleting(null)
      showToast('계정을 목록에서 삭제했습니다')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '계정을 삭제하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="계정"
      subtitle={`같은 시드 문구에서 파생된 계정 ${accounts.length}개`}
    >
      <div className="mt-1 space-y-2">
        {accounts.map((account) => {
          const active = account.index === activeIndex
          const isEditing = editing === account.index
          const isDeleting = deleting === account.index
          return (
            <div
              key={account.index}
              data-account-index={account.index}
              data-account-address={account.address}
              className={cx(
                'rounded-[18px] px-4 py-3.5',
                active ? 'bg-surface ring-1 ring-ink/10' : 'bg-surface',
              )}
            >
              <div className="flex items-center gap-3">
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

                {!isEditing && !isDeleting && (
                  <>
                    <button
                      onClick={() => {
                        setEditing(account.index)
                        setDraft(account.name)
                      }}
                      disabled={busy}
                      aria-label="이름 바꾸기"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-muted active:opacity-60 disabled:opacity-40"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => setDeleting(account.index)}
                      disabled={busy || accounts.length < 2}
                      aria-label="계정 삭제"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-muted active:opacity-60 disabled:opacity-30"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}

                {active && !isEditing && !isDeleting && <Check size={16} className="text-mint" />}
              </div>

              {isDeleting && (
                <div className="mt-2.5 flex items-center gap-2 rounded-[12px] bg-card px-3 py-2">
                  <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
                    목록에서만 지웁니다. 시드 문구로 같은 주소를 다시 추가할 수 있습니다.
                  </p>
                  <button
                    onClick={() => void remove(account.index)}
                    disabled={busy}
                    className="shrink-0 rounded-full bg-dangerSoft px-3 py-1 text-[11.5px] font-semibold text-danger disabled:opacity-50"
                  >
                    삭제
                  </button>
                  <button
                    onClick={() => setDeleting(null)}
                    disabled={busy}
                    className="shrink-0 rounded-full px-2 py-1 text-[11.5px] font-semibold text-muted"
                  >
                    취소
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button
        onClick={() => void add()}
        disabled={busy || full}
        className="mt-3 flex w-full items-center gap-2 rounded-[18px] bg-surface px-4 py-3.5 text-left active:bg-press disabled:opacity-50"
      >
        <Plus size={15} className="text-ink" />
        <span className="text-[13px] font-semibold text-ink">
          {full ? '계정 한도에 도달했습니다' : '계정 추가'}
        </span>
        {!full && <span className="ml-auto text-[11px] text-faint">m/44'/501'/{nextIndex}'/0'</span>}
      </button>

      <p className="mt-4 px-1 text-[10.5px] leading-[1.7] text-faint">
        계정은 모두 {meta ? '같은 시드 문구' : '시드 문구'}에서 파생됩니다. 시드 문구 하나만
        백업해 두면 이 목록 전체를 복원할 수 있습니다. 계정을 삭제해도 자산과 시드 문구는
        그대로이며, 같은 번호를 다시 추가하면 같은 주소가 돌아옵니다.
      </p>
    </Sheet>
  )
}
