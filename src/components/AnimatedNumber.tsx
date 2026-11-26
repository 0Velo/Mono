import { useAnimatedNumber } from '../hooks/useAnimatedNumber'

interface AnimatedNumberProps {
  value: number | null
  /** Formats one frame's interpolated value, so grouping and currency stay identical to the rest of the app. */
  format: (value: number | null) => string
  className?: string
  animate?: boolean
  duration?: number
  snapKey?: string
}

/**
 * Renders a balance through the rolling hook. It is its own component on
 * purpose: the 60fps state lives here, so a rolling total re-renders one span
 * instead of the whole screen behind it.
 */
export function AnimatedNumber({
  value,
  format,
  className,
  animate = true,
  duration,
  snapKey,
}: AnimatedNumberProps) {
  const shown = useAnimatedNumber(value, { animate, duration, snapKey })
  return <span className={className}>{format(shown)}</span>
}
