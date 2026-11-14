/**
 * What a finger means on a row of the conversation list, from how far it has moved since it touched
 * the row. Within a few pixels it is still holding the row, which may become a long press. Past
 * them, leftward more than up or down, it swipes the row. Any other way, it scrolls the list, or
 * goes right, which a row doesn't answer.
 */
export type Drift = 'holding' | 'swiping' | 'elsewhere';

/** How far a finger may drift from where it touched a row while it still holds it. */
const SLOP = 10;

/** How far left, as a share of its width, a finger swipes a row before letting go archives it. */
const SWIPE_SHARE = 0.4;

/** What a finger `dx` across and `dy` down from where it touched a row is doing to it. */
export function driftOf(dx: number, dy: number): Drift {
  if (Math.hypot(dx, dy) <= SLOP) return 'holding';
  return dx < 0 && -dx > Math.abs(dy) ? 'swiping' : 'elsewhere';
}

/** Whether a swipe let go `dx` across from where it started archives a row `width` wide. */
export const archives = (dx: number, width: number): boolean => -dx > width * SWIPE_SHARE;
