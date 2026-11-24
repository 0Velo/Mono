import { useEffect, useState } from 'react'

let notify: ((message: string) => void) | null = null

export function showToast(message: string) {
  if (notify) notify(message)
}

export function ToastHost() {
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let timer: number | undefined
    notify = (next: string) => {
      setMessage(next)
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => setMessage(null), 1900)
    }
    return () => {
      notify = null
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  if (!message) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+96px)] z-[60] flex justify-center px-6">
      <div className="animate-pop rounded-full bg-ink px-4 py-2.5 text-[13px] font-medium text-white">
        {message}
      </div>
    </div>
  )
}
