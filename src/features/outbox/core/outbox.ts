import type { MessageRef, Outgoing } from '../../mail/core/index.ts';

/**
 * The Outbox's state machine. Undo send and send later are the same thing: Send schedules a saved
 * draft, and when its time comes the Mailroom hands it to the host in two steps that are each safe
 * to repeat. `submit` gives the host the message, and `file` leaves one copy in Sent and removes
 * the draft. The Outbox records the host's acceptance between them, so whatever fails or restarts
 * after that point only files again, and nothing is delivered twice.
 *
 *   waiting ──begin──▶ sending ──sent──▶ accepted ──filed──▶ done
 *    ▲    ▲               │                │    ▲
 *    │    └───passing─────┤                └────┘ any failure, retried on its own, or
 *  retry                  │ refused, missing,       the host's own copy not in Sent yet
 *    │                    ▼ or cut short by a restart
 *    └──────────────── failed
 *
 * A host that files its own copy in Sent, as Zoho and Outlook do, may file it a while after it
 * accepts the message, or never once its member turns that off. So for `HOST_FILING_SECONDS`
 * after acceptance, filing leaves Sent to such a host and looks for its copy at 2, 4, 8, 16, 32
 * and 64 seconds. After that it files a copy itself if none came.
 *
 * A passing failure, such as no connection or an SMTP 4xx, retries on its own after 1, 2, 4, 8, 16
 * and 32 minutes and then hourly, until its retries have waited a day. A refusal, or a connection
 * lost after the message went out, waits for the member's Retry. So does a send found mid-submit
 * after a restart: the host may have accepted it in the instant before the Outbox could record it,
 * and a message held with an honest reason can be sent again, where a duplicate can't be taken back.
 *
 * The Mailroom drives it. It calls `recover` once as it starts, before it begins anything. Then
 * each wake takes the first of `due` until nothing is, stores `begin` before it submits and the
 * outcome after each step, and sets its alarm for `nextWake`. One wake runs at a time, and it reads
 * the Outbox again before each step, since a command may have cancelled or retried an entry.
 */

/** What a submit came to: the host has the message, now or before, or the draft is gone. */
export type Submitted = 'sent' | 'missing' | Failure;

/** What filing came to: done, or not yet, since the host's own copy is not in Sent yet. */
export type Filed = 'filed' | 'unfiled' | Failure;

/**
 * Why an attempt failed. `passing` when the same attempt may well succeed later and cannot have
 * delivered anything, such as no connection or an SMTP 4xx.
 */
export type Failure = { error: string; passing: boolean };

/**
 * The next step for an entry whose time has come. Filing leaves Sent to a host that files its own
 * copy while `waitForHost`.
 */
export type Due =
  | { step: 'submit'; outgoing: Outgoing }
  | { step: 'file'; outgoing: Outgoing; waitForHost: boolean };

export const RESTARTED =
  'Trail Mix restarted while sending this, so it may have gone. Retry sends it again.';
export const MISSING = 'The draft is no longer in Drafts, so it was not sent.';

/** Retries wait 1, 2, 4, 8, 16 and 32 minutes, then an hour each. */
const RETRY_MINUTES = [1, 2, 4, 8, 16, 32];
const HOURLY = 60;
/** How long a send's automatic retries may wait in all before it waits for Retry instead. */
const RETRYING_MINUTES = 24 * 60;

/** How long Send can be undone, as Apple Mail's default. */
export const UNDO_SECONDS = 10;

/** How long after acceptance filing leaves Sent to a host that files its own copy. */
export const HOST_FILING_SECONDS = 120;
/** How long filing waits before it first looks again for the host's copy. */
const FIRST_LOOK_SECONDS = 2;

/**
 * A draft scheduled at `now` to go when the undo window closes, or at `at` if that is later, for a
 * send scheduled ahead. The window opens at `opened`, when the member pressed Send, which is before
 * `now` when the draft's last save kept the device from asking at once. One that has closed by now
 * sends now.
 */
export function schedule(
  entry: Pick<Outgoing, 'id' | 'draft' | 'messageId' | 'to' | 'subject'>,
  now: string,
  at?: string,
  opened: string = now,
): Outgoing {
  const undone = Date.parse(opened) + UNDO_SECONDS * 1000;
  const later = at === undefined ? 0 : Date.parse(at);
  const sendAt = new Date(Math.max(Date.parse(now), undone, later)).toISOString();
  return { ...entry, sendAt, state: 'waiting', attempts: 0 };
}

/**
 * Undo, or giving up on a send: the draft it would have sent, untouched. Refused once the send is
 * due, whether or not the Mailroom has woken to begin it, so the undo window closes when a
 * countdown reaches zero and a send that leaves the Outbox after its time has gone. A failed send
 * can always be given up.
 */
export function cancel(outgoing: Outgoing, now: string): MessageRef {
  if (outgoing.state === 'accepted') throw new Error('It has been sent.');
  const isDue = outgoing.state === 'waiting' && Date.parse(now) >= Date.parse(outgoing.sendAt);
  if (outgoing.state === 'sending' || isDue)
    throw new Error('It is being sent, so it can’t be undone.');
  return outgoing.draft;
}

/**
 * The member's Retry: a failed send starts over now, with a day of retries ahead of it. A send
 * that is retrying on its own, or filing, tries now. Refused while an attempt is under way.
 */
export function retry(outgoing: Outgoing, now: string): Outgoing {
  if (outgoing.state === 'sending') throw new Error('It is being sent.');
  if (outgoing.state === 'failed') {
    const { error: _error, ...rest } = outgoing;
    return { ...rest, state: 'waiting', sendAt: now, attempts: 0 };
  }
  return { ...outgoing, sendAt: now };
}

/** What a wake does at `now`: each entry whose time has come, soonest first. */
export function due(outbox: readonly Outgoing[], now: string): Due[] {
  return pending(outbox)
    .filter(({ sendAt }) => Date.parse(sendAt) <= Date.parse(now))
    .map((outgoing) =>
      outgoing.state === 'waiting'
        ? { step: 'submit', outgoing }
        : { step: 'file', outgoing, waitForHost: Date.parse(now) < hostFilesBy(outgoing) },
    );
}

/** When the Mailroom should next wake for the Outbox, or nothing if no entry is waiting on time. */
export function nextWake(outbox: readonly Outgoing[]): string | undefined {
  return pending(outbox)[0]?.sendAt;
}

/** A send about to submit. It is stored before the host is reached, so a restart can tell. */
export function begin(outgoing: Outgoing): Outgoing {
  if (outgoing.state !== 'waiting') throw new Error(`A ${outgoing.state} send cannot begin.`);
  return { ...outgoing, state: 'sending' };
}

/** A send after its submit. Accepted, it files at once. */
export function submitted(outgoing: Outgoing, outcome: Submitted, now: string): Outgoing {
  if (outgoing.state !== 'sending') throw new Error(`A ${outgoing.state} send did not submit.`);
  const { error: _error, ...rest } = outgoing;
  if (outcome === 'sent')
    return { ...rest, state: 'accepted', sendAt: now, acceptedAt: now, attempts: 0 };
  if (outcome === 'missing') return failed(outgoing, MISSING);
  const attempts = outgoing.attempts + 1;
  if (!outcome.passing || waited(attempts) > RETRYING_MINUTES)
    return failed(outgoing, outcome.error);
  return {
    ...rest,
    state: 'waiting',
    sendAt: later(now, attempts),
    attempts,
    error: outcome.error,
  };
}

/**
 * A send after filing: done, and out of the Outbox, or filing again later, however long it takes.
 * While the host's own copy is not in Sent yet, it looks again once it has waited as long again as
 * it has since acceptance, and last when the wait for the host is over.
 */
export function filed(outgoing: Outgoing, outcome: Filed, now: string): Outgoing | 'done' {
  if (outgoing.state !== 'accepted') throw new Error(`A ${outgoing.state} send cannot be filed.`);
  if (outcome === 'filed') return 'done';
  if (outcome === 'unfiled') {
    const { error: _error, ...rest } = outgoing;
    const waited = Date.parse(now) - Date.parse(outgoing.acceptedAt ?? now);
    const look = Date.parse(now) + Math.max(FIRST_LOOK_SECONDS * 1000, waited);
    const sendAt = new Date(Math.max(Math.min(look, hostFilesBy(outgoing)), Date.parse(now)));
    return { ...rest, sendAt: sendAt.toISOString(), attempts: 0 };
  }
  const attempts = outgoing.attempts + 1;
  return { ...outgoing, sendAt: later(now, attempts), attempts, error: outcome.error };
}

/**
 * The Outbox as a Mailroom finds it when it starts. A send it finds mid-submit was cut short by
 * the restart, and the host may have accepted it, so it is held for the member to decide.
 */
export function recover(outbox: readonly Outgoing[]): Outgoing[] {
  return outbox.map((outgoing) =>
    outgoing.state === 'sending' ? failed(outgoing, RESTARTED) : outgoing,
  );
}

/** When the wait for a host's own copy in Sent is over: at once for a send from before it was kept. */
function hostFilesBy({ acceptedAt }: Outgoing): number {
  return acceptedAt === undefined ? 0 : Date.parse(acceptedAt) + HOST_FILING_SECONDS * 1000;
}

/** The entries that will wake the Mailroom, soonest first. */
function pending(outbox: readonly Outgoing[]): Outgoing[] {
  return outbox
    .filter(({ state }) => state === 'waiting' || state === 'accepted')
    .toSorted(
      (a, b) =>
        Date.parse(a.sendAt) - Date.parse(b.sendAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

function failed(outgoing: Outgoing, error: string): Outgoing {
  return { ...outgoing, state: 'failed', attempts: outgoing.attempts + 1, error };
}

/** The wait before the try after the `attempts`th failure, in minutes. */
function delay(attempts: number): number {
  return RETRY_MINUTES[attempts - 1] ?? HOURLY;
}

/** How long the retries after `attempts` failures wait in all, in minutes. */
function waited(attempts: number): number {
  let total = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) total += delay(attempt);
  return total;
}

function later(now: string, attempts: number): string {
  return new Date(Date.parse(now) + delay(attempts) * 60_000).toISOString();
}
