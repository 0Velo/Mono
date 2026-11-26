import { useEffect, useState } from 'react'
import { cx } from '../lib/format'

let notify: ((message: string) => void) | null = null

export function showToast(message: string) {
  if (notify) notify(message)
}

/** How long the message rests before it leaves. */
const HOLD_MS = 1900
/** Must outlast `.animate-toast-out`. */
const LEAVE_MS = 210

/**
 * 화면 위쪽에서 내려오는 토스트.
 *
 * The message drops in from above the safe area, rests, and lifts back out — the
 * same top edge the notification banners of the OS use, so it reads as an aside
 * rather than as part of the screen underneath. The live region stays mounted so
 * a message that arrives after the previous one is still announced; the bubble
 * itself is keyed per message, which is what lets a second toast restart the
 * drop instead of sitting still.
 */
export function ToastHost() {
  const [toast, setToast] = useState<{ message: string; seq: number } | null>(null)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    let seq = 0
    let holdTimer: number | undefined
    let leaveTimer: number | undefined
    const clear = () => {
      if (holdTimer) window.clearTimeout(holdTimer)
      if (leaveTimer) window.clearTimeout(leaveTimer)
    }
    notify = (next: string) => {
      clear()
      seq += 1
      setLeaving(false)
      setToast({ message: next, seq })
      holdTimer = window.setTimeout(() => {
        setLeaving(true)
        leaveTimer = window.setTimeout(() => setToast(null), LEAVE_MS)
      }, HOLD_MS)
    }
    return () => {
      notify = null
      clear()
    }
  }, [])

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-5"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}
      role="status"
      aria-live="polite"
    >
      {toast && (
        <div
          key={toast.seq}
          className={cx(
            'max-w-full rounded-full bg-ink/95 px-4 py-2.5 text-[13px] font-medium leading-snug text-onInk shadow-[0_10px_30px_-12px_rgba(13,14,18,0.55)] backdrop-blur',
            leaving ? 'animate-toast-out' : 'animate-toast-in',
          )}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
