interface SuccessMarkProps {
  /** Diameter in px — the badge the app already used for its completion screen. */
  size?: number
}

/**
 * The completion mark for a send or a swap: the tick draws itself inside the
 * mint disc while two soft rings breathe outward and fade. Only `currentColor`
 * and the theme's mint-soft token are used, so it stays matte in both moods.
 * Motion comes from three CSS keyframes and is dropped wholesale by the global
 * `prefers-reduced-motion` rule, which lands the tick fully drawn.
 */
export function SuccessMark({ size = 64 }: SuccessMarkProps) {
  return (
    <div
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className="animate-success-ring pointer-events-none absolute inset-0 rounded-full bg-mint/20"
      />
      <span
        aria-hidden="true"
        className="animate-success-ring pointer-events-none absolute inset-0 rounded-full bg-mint/10 [animation-delay:180ms]"
      />
      <span
        className="animate-pop relative flex h-full w-full items-center justify-center rounded-full bg-mintSoft text-mint"
        style={{ animationDuration: '300ms' }}
      >
        <svg
          viewBox="0 0 32 32"
          width={Math.round(size * 0.44)}
          height={Math.round(size * 0.44)}
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8.6 16.5 13.8 21.5 23.4 11.4"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="animate-check"
          />
        </svg>
      </span>
    </div>
  )
}
