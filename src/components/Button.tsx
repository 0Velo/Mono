import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '../lib/format'
import { Spinner } from './Spinner'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'mint'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  loading?: boolean
  full?: boolean
  children: ReactNode
}

const styles: Record<Variant, string> = {
  primary:
    'bg-ink text-onInk active:opacity-90 disabled:bg-surface2 disabled:text-faint',
  secondary:
    'bg-surface text-ink active:bg-press disabled:bg-surface disabled:text-faint2',
  ghost: 'bg-transparent text-muted active:bg-surface disabled:text-faint2',
  danger: 'bg-dangerSoft text-danger active:opacity-90 disabled:text-danger/40',
  mint: 'bg-mintSoft text-mint active:opacity-90',
}

export function Button({
  variant = 'primary',
  loading,
  full,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'press inline-flex h-[54px] items-center justify-center gap-2 rounded-full px-5 text-[15.5px] font-semibold tracking-[-0.02em] disabled:cursor-not-allowed',
        full && 'w-full',
        styles[variant],
        className,
      )}
    >
      {loading && <Spinner size={17} />}
      {children}
    </button>
  )
}
