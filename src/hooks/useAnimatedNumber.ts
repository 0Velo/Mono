import { useEffect, useRef, useState } from 'react'

/** Long enough to read the movement, short enough to beat the next refresh. */
const ROLL_MS = 520
/** Below half a cent there is nothing to see; snapping avoids a pointless frame loop. */
const STILL = 0.005

function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

interface RollOptions {
  /** false snaps: hidden balances and other states where motion would draw the eye. */
  animate?: boolean
  duration?: number
  /** A change of unit (USD ↔ KRW) is a re-reading, not a movement — snap instead of rolling. */
  snapKey?: string
}

/**
 * A number that travels to its next value instead of jumping.
 *
 * Balances arrive from the RPC in bursts, so landing them over ~520ms of
 * cubic-out reads as "this much moved" without the slot-machine feel of a long
 * roll. The first value a number ever sees is shown as-is (there is nothing to
 * roll from), hidden balances and reduced-motion devices snap, and the roll
 * starts from whatever is on screen, so an interrupted animation never jumps.
 */
export function useAnimatedNumber(target: number | null, options: RollOptions = {}): number | null {
  const { animate = true, duration = ROLL_MS, snapKey = '' } = options
  const [shown, setShown] = useState<number | null>(target)
  const shownRef = useRef<number | null>(target)
  const frameRef = useRef<number | null>(null)
  const snapRef = useRef(snapKey)

  useEffect(() => {
    const unitChanged = snapRef.current !== snapKey
    snapRef.current = snapKey

    const cancel = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
    const settle = (value: number | null) => {
      cancel()
      shownRef.current = value
      setShown(value)
    }

    if (target === null || !Number.isFinite(target)) {
      settle(null)
      return
    }

    const from = shownRef.current
    const rollable =
      animate &&
      !unitChanged &&
      from !== null &&
      Number.isFinite(from) &&
      !reducedMotion() &&
      Math.abs(target - from) > STILL

    if (!rollable) {
      settle(target)
      return
    }

    const started = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      if (progress >= 1) {
        frameRef.current = null
        shownRef.current = target
        setShown(target)
        return
      }
      const next = from + (target - from) * easeOutCubic(progress)
      shownRef.current = next
      setShown(next)
      frameRef.current = requestAnimationFrame(step)
    }

    cancel()
    frameRef.current = requestAnimationFrame(step)
    return cancel
  }, [target, animate, duration, snapKey])

  return shown
}
