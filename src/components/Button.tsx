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
    'bg-ink text-white active:bg-[#1D1F27] disabled:bg-[#E3E5E9] disabled:text-[#AEB4BD]',
  secondary:
    'bg-surface text-ink active:bg-[#EAEDF1] disabled:bg-[#F7F8FA] disabled:text-[#C3C8D0]',
  ghost: 'bg-transparent text-muted active:bg-surface disabled:text-[#C9CDD4]',
  danger: 'bg-dangerSoft text-danger active:bg-[#FBE7E7] disabled:text-[#F3B4B4]',
  mint: 'bg-mintSoft text-mint active:bg-[#E1F3E8]',
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
