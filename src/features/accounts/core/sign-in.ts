import type { AccountId } from '../../mail/core/index.ts';
import { EXPIRED, type DeviceCode, type Polled } from '../../providers/imap/core/index.ts';

/**
 * A sign-in at a vendor, as the Mailroom keeps it while the member enters the code on the vendor's
 * page. The Mailroom polls the vendor, since the member's tab sleeps while they're away at it.
 *
 *   waiting ──approved──▶ checking ──both hosts take the token──▶ gone, and the account is in
 *      │                     │
 *      │ declined, expired,  │ a host refused it,
 *      │ or refused          │ or a restart cut the check short
 *      ▼                     ▼
 *   refused ──once its code has expired, and five minutes on──▶ gone
 *
 * Nothing but the reason outlives a sign-in that stops: no account, no credential, no token. The
 * device code, which redeems the tokens, is sealed beside this record and never leaves the
 * Mailroom. The code the member types is for reading, and is the only part a browser sees.
 *
 * The Mailroom drives it. It calls `recover` on each record once as it starts. Each wake polls the
 * records `due` says to, stores what `polled` returns, and sets its alarm for `nextWake`. Records
 * `kept` says no to are deleted as they're read.
 */
export type Pending = {
  /** One sign-in per address. Starting another replaces it. */
  address: string;
  /** The account to add, or the one signing in again. */
  to: NewAccount | { account: AccountId };
  code: string;
  link: string;
  expiresAt: number;
  interval: number;
  pollAt: number;
} & ({ state: 'waiting' | 'checking' } | { state: 'refused'; reason: string; stoppedAt: number });

/** An account that signs in at its vendor, as the member named it, apart from its address. */
export type NewAccount = { preset: 'outlook'; name: string; fromName?: string };

/** How long a reason stays after a sign-in stops, so a member back from the vendor's page reads it. */
export const KEEP_REASON_MS = 5 * 60_000;

export const RESTARTED_SIGN_IN = 'Trail Mix restarted before the sign-in finished. Get a new code.';

/** A sign-in that has its code, waiting for the member, with its first poll an interval away. */
export function started(
  address: string,
  to: Pending['to'],
  code: Omit<DeviceCode, 'deviceCode'>,
  now: number,
): Pending {
  const { code: typed, link, expiresAt, interval } = code;
  return {
    address,
    to,
    code: typed,
    link,
    expiresAt,
    interval,
    pollAt: now + interval,
    state: 'waiting',
  };
}

/**
 * What a waiting sign-in needs now: a poll once its interval has passed, or to stop once its code
 * has expired, which the vendor would only say on the next poll.
 */
export function due(pending: Pending, now: number): 'poll' | 'expire' | undefined {
  if (pending.state !== 'waiting') return undefined;
  if (now >= pending.expiresAt) return 'expire';
  return now >= pending.pollAt ? 'poll' : undefined;
}

/** A sign-in after a poll. Approved, it's checked next, with the tokens the poll gave. */
export function polled(pending: Pending, result: Polled, now: number): Pending {
  if ('pending' in result)
    return { ...pending, interval: result.pending, pollAt: now + result.pending };
  if ('granted' in result) return { ...common(pending), state: 'checking' };
  return refused(pending, result.refused, now);
}

/** A sign-in that stopped, and why. */
export function refused(pending: Pending, reason: string, now: number): Pending {
  return { ...common(pending), state: 'refused', reason, stoppedAt: now };
}

/** A sign-in whose code has expired. */
export const expired = (pending: Pending, now: number) => refused(pending, EXPIRED, now);

/**
 * A sign-in as a new instance finds it. One that was being checked was cut short: its tokens were
 * only in memory, and the code that gave them is spent, so it stops.
 */
export function recover(pending: Pending, now: number): Pending {
  return pending.state === 'checking' ? refused(pending, RESTARTED_SIGN_IN, now) : pending;
}

/** Whether a sign-in is still kept: until it finishes, or a while after it stops. */
export function kept(pending: Pending, now: number): boolean {
  if (pending.state !== 'refused') return true;
  return now < Math.max(pending.expiresAt, pending.stoppedAt + KEEP_REASON_MS);
}

/** When the next waiting sign-in needs a wake: its next poll, or its expiry if that comes first. */
export function nextWake(pendings: readonly Pending[]): number | undefined {
  const times = pendings.flatMap((pending) =>
    pending.state === 'waiting' ? [Math.min(pending.pollAt, pending.expiresAt)] : [],
  );
  return times.length ? Math.min(...times) : undefined;
}

/** A sign-in without what its state alone carries. */
function common(pending: Pending) {
  const { address, to, code, link, expiresAt, interval, pollAt } = pending;
  return { address, to, code, link, expiresAt, interval, pollAt };
}
