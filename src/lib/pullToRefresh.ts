/**
 * Pull-to-refresh geometry.
 *
 * The distance the finger travels is not the distance the indicator travels:
 * the pull is resisted by a constant factor so a short drag still feels like a
 * gesture and a long one never tears the layout apart. Keeping the arithmetic
 * here (out of the touch handler) is what lets the thresholds be tested.
 */

/** The resisted distance at which letting go actually refreshes. */
export const PULL_THRESHOLD = 64
/** The most the indicator ever comes down, however hard the person pulls. */
export const PULL_MAX = 96
/** A finger moves ~1.8× further than the indicator it is dragging. */
const RESISTANCE = 0.55

/** Finger travel (px, downward) → indicator travel (px). */
export function resistedPull(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0
  return Math.min(PULL_MAX, distance * RESISTANCE)
}

/** 0 → 1 across the threshold, for the arrow's rotation and the fade. */
export function pullProgress(pulled: number): number {
  if (!Number.isFinite(pulled) || pulled <= 0) return 0
  return Math.min(1, pulled / PULL_THRESHOLD)
}

/** Whether releasing at this finger travel refreshes. */
export function pulledEnough(distance: number): boolean {
  return resistedPull(distance) >= PULL_THRESHOLD
}
