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
  | { is: 'undone' }
  /**
   * This device has yet to hand it to the Mailroom, which it couldn't reach for what `error` says,
   * and keeps trying. Its window, or its wait for a later time, may still be open here.
   */
  | { is: 'unreached'; error: string; isWaiting: boolean };

/**
 * When a send's undo window closes, in milliseconds on this device's clock, or when it is due, for
 * a send at a later time. The Mailroom's clock may differ, so a device that asked for a send counts
 * from its press, which is no later than the start the Mailroom counts from, since the device tells
 * it how long ago the press was and the telling takes time. A device that only reads the Outbox
 * trusts its clock.
 */
export const closesAfterPress = (pressed: number, at?: string) =>
  Math.max(pressed + UNDO_SECONDS * 1000, at === undefined ? 0 : Date.parse(at));

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
    case 'waiting':
      if (held.error !== undefined) return { is: 'retrying', error: held.error, at: held.sendAt };
      return standingOfWait(held.sendAt, closes, now);
  }
}

/** Where a send waiting to go at `sendAt`, its window closing at `closes` here, stands at `now`. */
export function standingOfWait(sendAt: string, closes: number, now: number): Standing {
  const left = closes - now;
  if (left > UNDO_SECONDS * 1000) return { is: 'scheduled', at: sendAt };
  if (left > 0) return { is: 'counting', seconds: Math.ceil(left / 1000) };
  return { is: 'sending' };
}

/**
 * What a device has seen of a send it follows, snapshot by snapshot: the entry as last seen, whether
 * it was begun then, and when it was first seen gone. A send leaves the Outbox when it has gone or
 * when someone undoes it or gives it up, and a snapshot can arrive late or not at all, so its
 * absence alone never says it went. Only the last sighting counts: a send begun once may have
 * failed since, and then been given up or retried and undone.
 */
export type Followed = { last: Outgoing; hasBegun: boolean; goneAt?: number };

export const followed = (outgoing: Outgoing): Followed => ({
  last: outgoing,
  hasBegun: isBegun(outgoing),
});

/** What a device has seen once a snapshot, taken by `at`, holds `entry` or nothing for the send. */
export function follow(seen: Followed, entry: Outgoing | undefined, at: number): Followed {
  if (!entry) return seen.goneAt === undefined ? { ...seen, goneAt: at } : seen;
  return followed(entry);
}

const isBegun = ({ state }: Outgoing) => state === 'sending' || state === 'accepted';

/**
 * Where a followed send stands at `now`. It has gone once the host accepted it, once it left the
 * Outbox while it was begun, or once Sent holds its copy. It was undone if it was seen gone before
 * its window could close, since nothing sends before then, and given up if it left failed. Gone
 * otherwise, it is still sending as far as this device can say.
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
  if (seen.last.state === 'failed') return { is: 'undone' };
  return seen.goneAt < closes ? { is: 'undone' } : { is: 'sending' };
}

/**
 * Whether a followed send is under way by `now` on this device's clock: its window has closed, or
 * the Outbox has begun it, failed it or seen it go. A send that failed was past its window, even if
 * this device's countdown last looked a moment before it closed.
 */
export const isUnderWay = (seen: Followed, closes: number, now: number): boolean =>
  seen.goneAt !== undefined ||
  seen.last.state !== 'waiting' ||
  seen.last.error !== undefined ||
  now >= closes;

/**
 * Where a press stands while this device keeps asking the Mailroom to take it: as it would, until
 * asking again has failed for a while, and then unreached, for what failed last, until an ask
 * lands. Only a press the Mailroom hasn't shown in its Outbox.
 */
export function standingOfPress(standing: Standing, unreached: string | undefined): Standing {
  if (unreached === undefined) return standing;
  const error = /[.!?…]$/.test(unreached) ? unreached : `${unreached}.`;
  return { is: 'unreached', error, isWaiting: isUndoable(standing) };
}

/**
 * Whether a send that stands so can still be undone: while its window, or its wait for a later
 * time, is open on this device's clock.
 */
export const isUndoable = (standing: Standing) =>
  standing.is === 'counting' ||
  standing.is === 'scheduled' ||
  (standing.is === 'unreached' && standing.isWaiting);

/** Whether a send that stands so is leaving, which the airmail stripe marks. */
export const isLeaving = (standing: Standing) =>
  standing.is !== 'failed' && standing.is !== 'undone';

/**
 * Whether a send that stands so is on its way, which running airmail marks: its window is counting
 * down, or it's sending. One scheduled for later, retrying later or sent is leaving, and still.
 */
export const isOnItsWay = (standing: Standing) =>
  standing.is === 'counting' || standing.is === 'sending';

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
