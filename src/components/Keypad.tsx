import { useEffect, useRef } from 'react'
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
            /*
             * 채워지는 점은 자기 자리에서 살짝 커졌다 앉는다. 빈 점과
             * 채워진 점을 다른 요소로 만들어 주는 `key` 덕분에, 애니메이션은
             * 몇 번째 점이든 채워지는 순간에만 한 번 돈다.
             */
            key={`${index}-${filled ? 'on' : 'off'}`}
            className={cx(
              'h-[9px] w-[9px] rounded-full',
              error
                ? 'bg-danger'
                : filled
                  ? 'animate-pin-pop bg-ink'
                  : 'scale-[0.86] bg-faint2',
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
  /*
   * `onComplete`는 화면이 다시 그려질 때마다 새 함수일 수 있다. 그것까지
   * 의존성에 넣으면 같은 PIN으로 다시 호출되거나(락 화면이 열려 있는 동안)
   * 예약된 호출이 취소된다(애니메이션 한 번에 다시 그려질 때) — 그래서 콜백은
   * ref로만 읽고, "이 값은 이미 넘겼다"를 값 자체로 기억한다.
   */
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const completedRef = useRef<string | null>(null)

  useEffect(() => {
    if (value.length < length) {
      completedRef.current = null
      return undefined
    }
    if (!onCompleteRef.current || completedRef.current === value) return undefined
    completedRef.current = value
    const timer = setTimeout(() => onCompleteRef.current?.(value), 90)
    return () => clearTimeout(timer)
  }, [value, length])

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
              'press flex items-center justify-center rounded-[20px] bg-surface text-[24px] font-medium tracking-[-0.01em] text-ink active:bg-press',
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
