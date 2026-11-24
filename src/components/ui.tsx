import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../lib/format'

/**
 * The wallet mark: three crisp slanted bars, monochrome, no container.
 * It reads as "Solana" without borrowing a purple app-icon box.
 */
export function BrandMark({
  size = 32,
  color = '#0D0E12',
}: {
  size?: number
  color?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <g fill={color}>
        <path d="M8.9 6.2h17.6l-3.3 3.8H5.6z" />
        <path d="M5.6 14.1h17.6l-3.3 3.8H2.3z" />
        <path d="M8.9 22h17.6l-3.3 3.8H5.6z" />
      </g>
    </svg>
  )
}

function SolGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <g fill="currentColor">
        <path d="M10.1 7.4h15.2l-2.9 3.3H7.2z" />
        <path d="M7.2 14.4h15.2l-2.9 3.3H4.3z" />
        <path d="M10.1 21.3h15.2l-2.9 3.3H7.2z" />
      </g>
    </svg>
  )
}

function UsdGlyph({ size, glyph }: { size: number; glyph: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="10.2" stroke="currentColor" strokeWidth="2.4" />
      <text
        x="16"
        y="21.4"
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        fill="currentColor"
        fontFamily="Pretendard Variable, Pretendard, system-ui, sans-serif"
      >
        {glyph}
      </text>
    </svg>
  )
}

function JupGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="6.4" stroke="currentColor" strokeWidth="2.2" />
      <ellipse
        cx="16"
        cy="16"
        rx="12"
        ry="4.3"
        transform="rotate(-22 16 16)"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function RayGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="4.6" stroke="currentColor" strokeWidth="2.4" />
      {Array.from({ length: 8 }).map((_, index) => {
        const angle = (index * Math.PI) / 4
        const x1 = 16 + Math.cos(angle) * 8.2
        const y1 = 16 + Math.sin(angle) * 8.2
        const x2 = 16 + Math.cos(angle) * 11.2
        const y2 = 16 + Math.sin(angle) * 11.2
        return (
          <line
            key={index}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

/**
 * The bespoke matte clay Solana coin, shot on pure white. Multiply blending on
 * the light surface makes the white backdrop disappear, so no square box shows.
 */
export function SolCoin3D({ size = 40 }: { size?: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <SolGlyph size={Math.round(size * 0.56)} />
  return (
    <img
      src={`${import.meta.env.BASE_URL}assets/3d/sol-coin.png`}
      alt=""
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(true)}
      className="h-full w-full select-none object-contain mix-blend-multiply"
    />
  )
}

const STABLE_GLYPHS: Record<string, string> = {
  USDC: '$',
  USDT: '₮',
  PYUSD: '$',
  USDS: '$',
}

function monogram(symbol: string): string {
  const clean = symbol.replace(/[^A-Za-z0-9]/g, '')
  if (!clean) return '?'
  if (clean.length <= 2) return clean.toUpperCase()
  // Keep 3–5 letter tickers readable but compact.
  return clean.slice(0, 2).toUpperCase()
}

/**
 * Token marks stay monochrome: a real minimal SVG mark for tokens we know,
 * a sober two-letter monogram for everything else.
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
  const glyphSize = Math.round(size * 0.56)

  let mark: ReactNode = null
  if (key === 'SOL' || key === 'WSOL') mark = <SolCoin3D size={size} />
  else if (STABLE_GLYPHS[key]) mark = <UsdGlyph size={glyphSize} glyph={STABLE_GLYPHS[key]} />
  else if (key === 'JUP') mark = <JupGlyph size={glyphSize} />
  else if (key === 'RAY') mark = <RayGlyph size={glyphSize} />

  return (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface text-ink"
      style={{ width: size, height: size }}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          width={size}
          height={size}
          className="h-full w-full bg-white object-cover"
          onError={(event) => {
            ;(event.currentTarget as HTMLImageElement).style.display = 'none'
          }}
        />
      ) : null}
      {mark ?? (
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
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="flex rounded-full bg-surface p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            'flex-1 rounded-full py-2 text-[12.5px] transition-colors',
            value === option.value
              ? 'bg-white font-semibold text-ink shadow-[0_1px_2px_rgba(13,14,18,0.06)]'
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
          'flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-[#EDEFF3]',
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
