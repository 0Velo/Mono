import { useState } from 'react'
import { Bookmark, Copy, Plus, Trash2 } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { useAddressBook, removeEntry, saveEntry } from '../lib/addressBook'
import { showToast } from '../components/Toast'
import { cx, shortAddress } from '../lib/format'

interface AddressBookSheetProps {
  open: boolean
  onClose: () => void
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

/** Saved recipients — the ones you send to more than once. */
export function AddressBookSheet({ open, onClose }: AddressBookSheetProps) {
  const book = useAddressBook()
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')

  const validAddress = address.trim().length >= 32 && address.trim().length <= 44 && BASE58.test(address.trim())

  const commit = () => {
    const entry = saveEntry(label, address)
    if (!entry) {
      showToast('이름과 주소를 확인하세요')
      return
    }
    showToast('주소록에 저장했습니다')
    setAdding(false)
    setLabel('')
    setAddress('')
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="주소록"
      subtitle="자주 쓰는 주소를 이름으로 저장합니다"
      footer={
        adding ? undefined : (
          <Button full variant="secondary" onClick={() => setAdding(true)}>
            <span className="flex items-center gap-1.5">
              <Plus size={15} /> 주소 추가
            </span>
          </Button>
        )
      }
    >
      {adding && (
        <div className="animate-pop mt-1 rounded-[18px] bg-surface p-4">
          <div className="text-[12px] font-medium text-muted">이름</div>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value.slice(0, 24))}
            placeholder="예: 투빗 입금"
            className="mt-1.5 w-full rounded-[12px] bg-card px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-faint"
            autoFocus
          />
          <div className="mt-3 text-[12px] font-medium text-muted">Solana 주소</div>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value.trim())}
            placeholder="주소"
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
              저장
            </Button>
            <Button
              full
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setLabel('')
                setAddress('')
              }}
            >
              취소
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 space-y-1">
        {book.map((entry) => (
          <div key={entry.id} className="flex items-center gap-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-muted">
              <Bookmark size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold text-ink">{entry.label}</div>
              <div className="mt-0.5 font-mono text-[10.5px] text-muted">
                {shortAddress(entry.address, 6)}
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(entry.address)
                  showToast('주소를 복사했습니다')
                } catch {
                  showToast('복사할 수 없습니다')
                }
              }}
              aria-label="주소 복사"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted active:opacity-60"
            >
              <Copy size={13} />
            </button>
            <button
              onClick={() => {
                removeEntry(entry.id)
                showToast('주소록에서 삭제했습니다')
              }}
              aria-label="삭제"
              className="flex h-8 w-8 items-center justify-center rounded-full text-faint active:opacity-60"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}

        {book.length === 0 && !adding && (
          <div className="py-8 text-center text-[12px] leading-relaxed text-muted">
            저장된 주소가 없습니다.
            <br />
            보내기 화면에서도 바로 저장할 수 있습니다.
          </div>
        )}
      </div>
    </Sheet>
  )
}
