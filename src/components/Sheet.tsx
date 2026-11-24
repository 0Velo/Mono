import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../lib/format'

interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  tall?: boolean
}

export function Sheet({ open, onClose, title, subtitle, children, footer, tall }: SheetProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        className="animate-fade absolute inset-0 bg-[#0D0E12]/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cx(
          'animate-sheet relative flex w-full max-w-[430px] flex-col rounded-t-[28px] bg-white',
          tall ? 'h-[92vh]' : 'max-h-[90vh]',
        )}
      >
        <div className="flex justify-center pb-1 pt-3">
          <div className="h-[4px] w-9 rounded-full bg-[#E4E7EB]" />
        </div>
        {(title || subtitle) && (
          <div className="flex items-start justify-between px-6 pb-2 pt-3">
            <div className="min-w-0">
              {title && (
                <h2 className="text-[20px] font-bold tracking-[-0.03em] text-ink">{title}</h2>
              )}
              {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              aria-label="닫기"
              className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-ink active:bg-[#E9ECF0]"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="no-scrollbar flex-1 overflow-y-auto px-6 pb-6 pt-2">{children}</div>
        {footer && (
          <div className="px-6 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3">{footer}</div>
        )}
      </div>
    </div>
  )
}
