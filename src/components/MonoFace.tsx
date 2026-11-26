import { useId } from 'react'
import { cx } from '../lib/format'

/**
 * The mascot's face.
 *
 * `MonoMark` ships a matte 3D render, not a rigged model: eyes, mouth and
 * silhouette are baked into the PNG. So expression is drawn *over* that
 * render, in the same coordinate box, from geometry measured off the artwork —
 * the goggles' white rings (`LENS`) and the black mouth slit (`MOUTH`) below
 * them. Everything is expressed in the 0–100 box and scaled with the mark, so
 * the image, its ratio and its alt/aria attributes stay exactly as they were;
 * this layer is decoration and is hidden from assistive tech.
 *
 * At the 92px the lock screen uses, only broad shapes survive: the lids closing
 * over the white rings (the one high-contrast feature on a black mascot), a
 * shaped mouth line, and small props (a sweat drop, mint sparkles).
 */

export type MonoMood = 'idle' | 'typing' | 'error' | 'success'

/** Lens rings measured on wallet-hero.png (900²): centre, radii, and which
 *  side faces the bridge of the goggles. */
const LENS = [
  { cx: 36.8, cy: 47.7, rx: 11, ry: 7.1, inner: 1 },
  { cx: 64.1, cy: 47.7, rx: 11, ry: 7.1, inner: -1 },
] as const

/** The mouth slit measured on the same render: centre and half width. */
const MOUTH = { cx: 50.5, cy: 57.2, half: 3.9 }

/** The body's own tone at the face — lids read as skin, not as paint. */
const LID = '#17191d'
/** The render's mouth is pure black; the shaped mouths stay that colour. */
const MOUTH_INK = '#000000'

const MINT = '#16A34A'

interface LidSpec {
  /** How much of the ring the lid covers, 0→1. */
  cover: number
  /** Millimetres of tilt, inner edge lower: a scowl. */
  tilt: number
  /** A bottom edge that arches up in the middle: a happy squint. */
  happy?: boolean
}

const LIDS: Record<MonoMood, LidSpec> = {
  idle: { cover: 0, tilt: 0 },
  typing: { cover: 0.1, tilt: 0 },
  // 연타 사이에 눈을 살짝 감은 채 키패드를 내려다보는 정도.
  error: { cover: 0.36, tilt: 0.62 },
  success: { cover: 0.5, tilt: 0, happy: true },
}

function lidPath(lens: (typeof LENS)[number], spec: LidSpec): string {
  const rx = lens.rx + 0.45
  const ry = lens.ry + 0.4
  const top = lens.cy - ry - 1
  const bottom = lens.cy - ry + ry * 2 * spec.cover
  const left = lens.cx - rx
  const right = lens.cx + rx
  const tilt = spec.tilt * lens.ry * lens.inner
  if (spec.happy) {
    const arch = Math.min(2.4, ry * 0.62)
    return `M${left} ${top} H${right} V${bottom} Q${lens.cx} ${bottom - arch * 2} ${left} ${bottom} Z`
  }
  return `M${left} ${top} H${right} V${bottom + tilt} L${left} ${bottom - tilt} Z`
}

export function MonoFace({ mood, className }: { mood: MonoMood; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const lids = LIDS[mood]
  const mouths = mood === 'error' || mood === 'success'

  return (
    <span
      className={cx('pointer-events-none absolute inset-0 select-none', className)}
      aria-hidden="true"
      data-mono-face={mood}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full overflow-visible">
        <defs>
          {LENS.map((lens, index) => (
            <clipPath id={`${id}-lens-${index}`} key={index}>
              <ellipse
                cx={lens.cx}
                cy={lens.cy}
                rx={lens.rx + 0.45}
                ry={lens.ry + 0.4}
              />
            </clipPath>
          ))}
        </defs>

        {mood === 'success' && (
          <>
            <circle
              cx={50}
              cy={50}
              r={42}
              fill="none"
              stroke={MINT}
              strokeWidth={1.1}
              className="mono-cheer-ring"
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />
            <g className="mono-sparkles" fill={MINT}>
              <path className="mono-sparkle mono-sparkle-a" d={sparkle(21, 27, 3.4)} />
              <path className="mono-sparkle mono-sparkle-b" d={sparkle(80, 23, 2.8)} />
              <path className="mono-sparkle mono-sparkle-c" d={sparkle(88, 46, 2.1)} />
            </g>
          </>
        )}

        {LENS.map((lens, index) => (
          <g clipPath={`url(#${id}-lens-${index})`} key={`lid-${index}`}>
            {lids.cover > 0 && <path d={lidPath(lens, lids)} fill={LID} />}
          </g>
        ))}

        {mouths && (
          <path
            d={
              mood === 'success'
                ? `M${MOUTH.cx - MOUTH.half} ${MOUTH.cy - 0.4} Q${MOUTH.cx} ${MOUTH.cy + 3.1} ${MOUTH.cx + MOUTH.half} ${MOUTH.cy - 0.4}`
                : `M${MOUTH.cx - MOUTH.half * 0.86} ${MOUTH.cy + 1.3} Q${MOUTH.cx} ${MOUTH.cy - 2.2} ${MOUTH.cx + MOUTH.half * 0.86} ${MOUTH.cy + 1.3}`
            }
            fill="none"
            stroke={MOUTH_INK}
            strokeWidth={1.45}
            strokeLinecap="round"
          />
        )}

        {mood === 'error' && (
          <g className="mono-sweat" fill="#adc0d4">
            <path d="M75.4 25.2c0 0 2.6 3.4 2.6 5.1a2.6 2.6 0 0 1-5.2 0c0-1.7 2.6-5.1 2.6-5.1Z" />
            <circle cx="74.4" cy="30.6" r="0.62" fill="#f4f8fc" opacity="0.85" />
          </g>
        )}
      </svg>
    </span>
  )
}

/** A four-point star, centred, as a single closed path. */
function sparkle(cx: number, cy: number, r: number): string {
  const inner = r * 0.26
  return [
    `M${cx} ${cy - r}`,
    `L${cx + inner} ${cy - inner}`,
    `L${cx + r} ${cy}`,
    `L${cx + inner} ${cy + inner}`,
    `L${cx} ${cy + r}`,
    `L${cx - inner} ${cy + inner}`,
    `L${cx - r} ${cy}`,
    `L${cx - inner} ${cy - inner}`,
    'Z',
  ].join(' ')
}
