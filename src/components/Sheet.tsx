import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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

/**
 * Bottom sheet with a real exit: on close the panel slides back down under a
 * fading backdrop before it unmounts, so dismissing never snaps.
 */
export function Sheet({ open, onClose, title, subtitle, children, footer, tall }: SheetProps) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (open) {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, 230)
    return () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [open, mounted])

  useEffect(() => {
    if (!mounted) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mounted, onClose])

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        className={cx(
          'absolute inset-0 bg-black/40',
          closing ? 'animate-backdrop-out' : 'animate-backdrop',
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'relative flex w-full max-w-[430px] flex-col rounded-t-[28px] bg-card shadow-[var(--sheet-shadow)]',
          closing ? 'animate-sheet-out' : 'animate-sheet',
          tall ? 'h-[92vh]' : 'max-h-[90vh]',
        )}
      >
        <div className="flex justify-center pb-1 pt-3">
          <div className="h-[4px] w-9 rounded-full bg-handle" />
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
              className="press -mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-ink"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="animate-sheet-body no-scrollbar flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-2">
          {children}
        </div>
        {footer && (
          <div className="px-6 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3">{footer}</div>
        )}
      </div>
    </div>
  )
}
