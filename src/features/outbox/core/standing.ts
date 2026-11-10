import type { Address, Outgoing } from '../../mail/core/index.ts';
import { UNDO_SECONDS } from './outbox.ts';

/**
 * Where a send stands, as a browser tells it: the undo toast that follows a send from the device
 * that made it, and the Outbox's rows. Each says no more than the Mailroom's snapshots, the copy in
 * Sent and the device's clock can show.
 */
export type Standing =
  /** Inside the undo window, with whole seconds left, rounded up. */
  | { is: 'counting'; seconds: number }
  /** Waiting for a time further off than the undo window. */
  | { is: 'scheduled'; at: string }
  /** Due or begun, or gone without a sign yet of whether it went. */
  | { is: 'sending' }
  /** The host accepted it. */
  | { is: 'sent' }
  /** It failed for a passing reason, and tries again at `at` on its own. */
  | { is: 'retrying'; error: string; at: string }
  /** It waits for the member's Retry. */
  | { is: 'failed'; error: string }
  /** It left the Outbox before its time, so someone undid it. */
  | { is: 'undone' };

/**
 * When a send's undo window closes, in milliseconds on this device's clock. The Mailroom's clock
 * may differ, so a device that asked for a send now counts from its press, which is no later than
 * the Mailroom's own start. A device that only reads the Outbox trusts its clock.
 */
export const closesAfterPress = (pressed: number) => pressed + UNDO_SECONDS * 1000;

export const closesAt = (outgoing: Outgoing) => Date.parse(outgoing.sendAt);

/**
 * Where a send the Outbox holds stands at `now`. Undo is offered only while counting or scheduled,
 * and ends when the window can first close on this clock, so it is never offered once the Mailroom
 * would refuse it for time.
 */
export function standingOf(held: Outgoing, closes: number, now: number): Standing {
  switch (held.state) {
    case 'failed':
      return { is: 'failed', error: held.error ?? '' };
    case 'accepted':
      return { is: 'sent' };
    case 'sending':
      return { is: 'sending' };
    case 'waiting': {
      if (held.error !== undefined) return { is: 'retrying', error: held.error, at: held.sendAt };
      const left = closes - now;
      if (left > UNDO_SECONDS * 1000) return { is: 'scheduled', at: held.sendAt };
      if (left > 0) return { is: 'counting', seconds: Math.ceil(left / 1000) };
      return { is: 'sending' };
    }
  }
}

/**
 * What a device has seen of a send it follows, snapshot by snapshot: the entry as last seen, whether
 * it was ever seen begun, and when it was first seen gone. A send leaves the Outbox when it has gone
 * or when someone undoes it, and a snapshot can arrive late or not at all, so its absence alone
 * never says it went.
 */
export type Followed = { last: Outgoing; hasBegun: boolean; goneAt?: number };

export const followed = (outgoing: Outgoing): Followed => ({ last: outgoing, hasBegun: false });

/** What a device has seen once a snapshot, taken by `at`, holds `entry` or nothing for the send. */
export function follow(seen: Followed, entry: Outgoing | undefined, at: number): Followed {
  if (!entry) return seen.goneAt === undefined ? { ...seen, goneAt: at } : seen;
  const hasBegun = seen.hasBegun || entry.state === 'sending' || entry.state === 'accepted';
  return { last: entry, hasBegun };
}

/**
 * Where a followed send stands at `now`. It has gone once the host accepted it, once it left the
 * Outbox after it was seen begun, or once Sent holds its copy. It was undone if it was seen gone
 * before its window could close, since nothing sends before then. Gone with neither, it is still
 * sending as far as this device can say.
 */
export function standingOfFollowed(
  seen: Followed,
  closes: number,
  now: number,
  isInSent: boolean,
): Standing {
  if (isInSent) return { is: 'sent' };
  if (seen.goneAt === undefined) return standingOf(seen.last, closes, now);
  if (seen.hasBegun) return { is: 'sent' };
  return seen.goneAt < closes ? { is: 'undone' } : { is: 'sending' };
}

/** Whether a send that stands so can still be undone. */
export const isUndoable = (standing: Standing) =>
  standing.is === 'counting' || standing.is === 'scheduled';

/** Whether a send that stands so is leaving, which the airmail stripe marks. */
export const isLeaving = (standing: Standing) =>
  standing.is !== 'failed' && standing.is !== 'undone';

/** Who a send is to, as a toast says it: "Mina", "Mina and Ada", or "Mina and 2 others". */
export function briefly(to: readonly Address[]): string {
  const [first, second] = to.map(({ name, email }) => name?.trim().split(/\s+/)[0] || email);
  if (first === undefined) return 'undisclosed recipients';
  if (second === undefined) return first;
  return to.length === 2 ? `${first} and ${second}` : `${first} and ${to.length - 1} others`;
}

/** Who a send is to, as its row lists them. A draft with only Bcc names nobody in To or Cc. */
export function fully(to: readonly Address[]): string {
  if (to.length === 0) return 'Undisclosed recipients';
  return to.map(({ name, email }) => name?.trim() || email).join(', ');
}
