import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../lib/format'

const ASSET_BASE = import.meta.env.BASE_URL
// Bumped when the artwork changes: the service worker caches /assets/ by URL,
// so a new query string is what makes an updated image actually replace an old one.
const ART_VERSION = 'v5'
const MARK_LIGHT = `${ASSET_BASE}assets/3d/wallet-hero.png?${ART_VERSION}`
const MARK_DARK = `${ASSET_BASE}assets/3d/wallet-hero-dark.png?${ART_VERSION}`

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
 * The official Solana logomark — one path, viewBox 101×88 — taken unmodified
 * from the Solana brand assets (solana.com/src/img/branding/solanaLogoMark.svg,
 * master kept at design/masters/solana-logomark-official.svg). Its own gradient
 * lives in the shipped SVG; this copy is filled with `currentColor` so the
 * fallback still renders if that image ever fails to load.
 */
const SOLANA_MARK_PATH =
  'M100.48 69.3817L83.8068 86.8015C83.4444 87.1799 83.0058 87.4816 82.5185 87.6878C82.0312 87.894 81.5055 88.0003 80.9743 88H1.93563C1.55849 88 1.18957 87.8926 0.874202 87.6912C0.558829 87.4897 0.31074 87.2029 0.160416 86.8659C0.0100923 86.529 -0.0359181 86.1566 0.0280382 85.7945C0.0919944 85.4324 0.263131 85.0964 0.520422 84.8278L17.2061 67.408C17.5676 67.0306 18.0047 66.7295 18.4904 66.5234C18.9762 66.3172 19.5002 66.2104 20.0301 66.2095H99.0644C99.4415 66.2095 99.8104 66.3169 100.126 66.5183C100.441 66.7198 100.689 67.0067 100.84 67.3436C100.99 67.6806 101.036 68.0529 100.972 68.415C100.908 68.7771 100.737 69.1131 100.48 69.3817ZM83.8068 34.3032C83.4444 33.9248 83.0058 33.6231 82.5185 33.4169C82.0312 33.2108 81.5055 33.1045 80.9743 33.1048H1.93563C1.55849 33.1048 1.18957 33.2121 0.874202 33.4136C0.558829 33.6151 0.31074 33.9019 0.160416 34.2388C0.0100923 34.5758 -0.0359181 34.9482 0.0280382 35.3103C0.0919944 35.6723 0.263131 36.0083 0.520422 36.277L17.2061 53.6968C17.5676 54.0742 18.0047 54.3752 18.4904 54.5814C18.9762 54.7875 19.5002 54.8944 20.0301 54.8952H99.0644C99.4415 54.8952 99.8104 54.7879 100.126 54.5864C100.441 54.3849 100.689 54.0981 100.84 53.7612C100.99 53.4242 101.036 53.0518 100.972 52.6897C100.908 52.3277 100.737 51.9917 100.48 51.723L83.8068 34.3032ZM1.93563 21.7905H80.9743C81.5055 21.7907 82.0312 21.6845 82.5185 21.4783C83.0058 21.2721 83.4444 20.9704 83.8068 20.592L100.48 3.17219C100.737 2.90357 100.908 2.56758 100.972 2.2055C101.036 1.84342 100.99 1.47103 100.84 1.13408C100.689 0.79713 100.441 0.510296 100.126 0.308823C99.8104 0.107349 99.4415 1.24074e-05 99.0644 0L20.0301 0C19.5002 0.000878397 18.9762 0.107699 18.4904 0.313848C18.0047 0.519998 17.5676 0.821087 17.2061 1.19848L0.524723 18.6183C0.267681 18.8866 0.0966198 19.2223 0.0325185 19.5839C-0.0315829 19.9456 0.0140624 20.3177 0.163856 20.6545C0.31365 20.9913 0.561081 21.2781 0.875804 21.4799C1.19053 21.6817 1.55886 21.7896 1.93563 21.7905Z'

/** Image-only fallback for the native asset when the coin image is missing. */
function SolanaGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 101 88" fill="none" aria-hidden="true">
      <path d={SOLANA_MARK_PATH} fill="currentColor" />
    </svg>
  )
}

/**
 * The real thing: the official Solana logomark on a matte black disc
 * (public/assets/3d/sol-coin.svg — official paths, published gradient). One
 * image serves both themes: on light the disc is the silhouette, on dark the
 * hairline ring inside its edge keeps the coin from melting into the surface.
 */
export function SolCoin3D({ size = 40 }: { size?: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        className="flex items-center justify-center rounded-full bg-surface2 text-ink"
        style={{ width: size, height: size }}
      >
        <SolanaGlyph size={Math.round(size * 0.88)} />
      </span>
    )
  }
  return (
    <img
      src={`${ASSET_BASE}assets/3d/sol-coin.svg?${ART_VERSION}`}
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
