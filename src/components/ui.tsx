import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../lib/format'

const ASSET_BASE = import.meta.env.BASE_URL
const MARK_LIGHT = `${ASSET_BASE}assets/3d/wallet-hero.png`
const MARK_DARK = `${ASSET_BASE}assets/3d/wallet-hero-dark.png`

/**
 * The Mono mark: the same sculptural matte emblem the app icon is cut from.
 *
 * Two transparent props are shipped — the obsidian emblem for light surfaces
 * and the alabaster one for dark — because a blend mode is the wrong tool here:
 * `.press` (will-change) creates a stacking context, so anything blended inside
 * a button would blend against transparency and show its plate.
 */
export function MonoMark({
  size = 32,
  className,
  alt = '',
}: {
  size?: number
  className?: string
  alt?: string
}) {
  return (
    <span
      className={cx('relative inline-block shrink-0 select-none', className)}
      style={{ width: size, height: size }}
      aria-hidden={alt ? undefined : true}
    >
      <img
        src={MARK_LIGHT}
        alt={alt}
        width={size}
        height={size}
        draggable={false}
        decoding="async"
        className="absolute inset-0 h-full w-full object-contain dark:hidden"
      />
      <img
        src={MARK_DARK}
        alt=""
        width={size}
        height={size}
        draggable={false}
        decoding="async"
        className="absolute inset-0 hidden h-full w-full object-contain dark:block"
      />
    </span>
  )
}

/**
 * Image-only fallback for the native asset when the 3D coin is missing.
 * (The bar glyph is never used as the app's brand mark.)
 */
function SolanaGlyph({ size }: { size: number }) {
  const fill = 'currentColor'
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <g fill={fill}>
        <path d="M9.2 6.4h16.6a.7.7 0 0 1 .55 1.13l-2.55 3.1a.7.7 0 0 1-.55.24H6.65a.7.7 0 0 1-.55-1.13l2.55-3.1a.7.7 0 0 1 .55-.24Z" />
        <path d="M6.65 13.5h16.6a.7.7 0 0 1 .55 1.13l-2.55 3.1a.7.7 0 0 1-.55.24H4.1a.7.7 0 0 1-.55-1.13l2.55-3.1a.7.7 0 0 1 .55-.24Z" />
        <path d="M9.2 20.6h16.6a.7.7 0 0 1 .55 1.13l-2.55 3.1a.7.7 0 0 1-.55.24H6.65a.7.7 0 0 1-.55-1.13l2.55-3.1a.7.7 0 0 1 .55-.24Z" />
      </g>
    </svg>
  )
}

/**
 * The real thing: a matte 3D coin carrying the official Solana three-bar
 * emblem, rendered on white. `mix-blend-multiply` makes the white plate vanish
 * on the light UI, so there is no square box around the disc.
 */
export function SolCoin3D({ size = 40 }: { size?: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        className="flex items-center justify-center rounded-full bg-surface2 text-ink"
        style={{ width: size, height: size }}
      >
        <SolanaGlyph size={Math.round(size * 0.78)} />
      </span>
    )
  }
  return (
    <img
      src={`${ASSET_BASE}assets/3d/sol-coin.png`}
      alt=""
      width={size}
      height={size}
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
      className="h-full w-full select-none object-contain"
      style={{ width: size, height: size }}
    />
  )
}

/** Recognisable marks for the tokens people actually hold. */
const TOKEN_ART: Record<string, string> = {
  USDC: 'usdc',
  USDT: 'usdt',
  PYUSD: 'usdc',
  JUP: 'jup',
  BONK: 'bonk',
  RAY: 'ray',
  JTO: 'jto',
  MSOL: 'msol',
}

function monogram(symbol: string): string {
  const clean = symbol.replace(/[^A-Za-z0-9]/g, '')
  if (!clean) return '?'
  if (clean.length <= 2) return clean.toUpperCase()
  // Keep 3–5 letter tickers readable but compact.
  return clean.slice(0, 2).toUpperCase()
}

/**
 * Real token artwork when we ship it (or when the price API hands us a logo),
 * a sober two-letter monogram otherwise. SOL is the 3D coin.
 */
export function TokenIcon({
  symbol,
  icon,
  size = 40,
}: {
  symbol: string
  icon?: string
  size?: number
}) {
  const key = symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const art = TOKEN_ART[key]
  const src = art ? `${ASSET_BASE}assets/tokens/${art}.png` : icon
  const [failed, setFailed] = useState(false)
  const lastSrc = useRef(src)

  useEffect(() => {
    if (lastSrc.current !== src) {
      lastSrc.current = src
      setFailed(false)
    }
  }, [src])

  if (key === 'SOL' || key === 'WSOL') return <SolCoin3D size={size} />

  return (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-card ring-1 ring-black/[0.05] dark:ring-white/10"
      style={{ width: size, height: size }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full select-none object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="font-semibold tracking-[-0.03em] text-ink"
          style={{ fontSize: Math.max(10, size * 0.29) }}
        >
          {monogram(symbol)}
        </span>
      )}
    </div>
  )
}

/** Kept as a named alias so call sites read naturally for the native asset. */
export function SolMark({ size = 40 }: { size?: number }) {
  return <TokenIcon symbol="SOL" size={size} />
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  compact,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  compact?: boolean
}) {
  return (
    <div className="flex rounded-full bg-surface p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            'flex-1 whitespace-nowrap rounded-full transition-all duration-200',
            compact ? 'py-1.5 text-[11.5px]' : 'py-2 text-[12.5px]',
            value === option.value
              ? 'bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(13,14,18,0.06)]'
              : 'font-medium text-muted',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A 1.5px line, no axes, no grid, no fill. Real price series when the price
 * API answers; nothing at all when it does not.
 */
export function Sparkline({
  data,
  height = 44,
  color = '#0D0E12',
}: {
  data: number[]
  height?: number
  color?: string
}) {
  const path = useMemo(() => {
    if (!data || data.length < 2) return null
    const step = Math.max(1, Math.ceil(data.length / 56))
    const series = data.filter((_, index) => index % step === 0)
    if (series.length < 2) return null
    let min = Infinity
    let max = -Infinity
    for (const value of series) {
      if (value < min) min = value
      if (value > max) max = value
    }
    const span = max - min || Math.max(0.0001, max * 0.01)
    const width = 320
    const inner = 100
    const pad = 7
    const points = series.map((value, index) => {
      const x = (index / (series.length - 1)) * width
      const y = inner - pad - ((value - min) / span) * (inner - pad * 2)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    return points.join(' ')
  }, [data])

  if (!path) return null
  return (
    <svg
      viewBox="0 0 320 100"
      preserveAspectRatio="none"
      width="100%"
      height={height}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={path}
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className="animate-draw"
      />
    </svg>
  )
}

export function Row({
  label,
  value,
  children,
  onClick,
  danger,
  className,
}: {
  label?: ReactNode
  value?: ReactNode
  children?: ReactNode
  onClick?: () => void
  danger?: boolean
  className?: string
}) {
  const content = (
    <>
      {children ?? (
        <>
          <span className={cx('text-[14.5px]', danger ? 'text-danger' : 'text-ink')}>{label}</span>
          <span className="flex items-center gap-1.5 text-[14.5px] text-muted">{value}</span>
        </>
      )}
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cx(
          'flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors active:bg-press',
          className,
        )}
      >
        {content}
      </button>
    )
  }
  return (
    <div className={cx('flex w-full items-center justify-between px-4 py-3.5', className)}>
      {content}
    </div>
  )
}
