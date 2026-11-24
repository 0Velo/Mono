import { useEffect } from 'react'
import { Delete } from 'lucide-react'
import { cx } from '../lib/format'

interface KeypadProps {
  value: string
  onChange: (next: string) => void
  length?: number
  onComplete?: (value: string) => void
  error?: boolean
  disabled?: boolean
  compact?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']

export function PinDots({
  value,
  length = 6,
  error,
}: {
  value: string
  length?: number
  error?: boolean
}) {
  return (
    <div className={cx('flex items-center justify-center gap-3.5', error && 'animate-shake')}>
      {Array.from({ length }).map((_, index) => {
        const filled = index < value.length
        return (
          <div
            key={index}
            className={cx(
              'h-[9px] w-[9px] rounded-full transition-all',
              error ? 'bg-danger' : filled ? 'bg-ink' : 'bg-[#DCDFE5]',
            )}
          />
        )
      })}
    </div>
  )
}

export function Keypad({
  value,
  onChange,
  length = 6,
  onComplete,
  error,
  disabled,
  compact,
}: KeypadProps) {
  useEffect(() => {
    if (!onComplete) return
    if (value.length === length) {
      const timer = setTimeout(() => onComplete(value), 90)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [value, length, onComplete])

  useEffect(() => {
    if (disabled) return
    const onKey = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key) && value.length < length) {
        onChange(value + event.key)
      } else if (event.key === 'Backspace') {
        onChange(value.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [value, length, onChange, disabled])

  const press = (key: string) => {
    if (disabled) return
    if (key === 'del') {
      onChange(value.slice(0, -1))
      return
    }
    if (!key) return
    if (value.length >= length) return
    onChange(value + key)
  }

  return (
    <div className={cx('grid grid-cols-3 gap-2.5', compact && 'gap-2')}>
      {KEYS.map((key, index) => {
        if (!key) return <div key={`empty-${index}`} />
        return (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            aria-label={key === 'del' ? '지우기' : key}
            className={cx(
              'flex items-center justify-center rounded-[20px] bg-surface text-[24px] font-medium tracking-[-0.01em] text-ink transition-colors active:bg-[#E9ECF0]',
              compact ? 'h-[52px]' : 'h-[58px]',
            )}
          >
            {key === 'del' ? <Delete size={20} strokeWidth={1.8} className="text-ink" /> : key}
          </button>
        )
      })}
    </div>
  )
}
