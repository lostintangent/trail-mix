import type { Envelope, Flags, FolderRef, SyncEvent } from '../../../mail/core/index.ts';
import { FIRST_SYNC_BATCH } from '../../provider.ts';

/**
 * IMAP sync reconciliation: what the server says about a folder now, compared with what the cursor
 * says was already reported, becomes sync events and the next cursor.
 *
 * A sync is one bounded batch, newest first. `planSync` names the envelopes and flags to fetch,
 * the provider fetches them, and the plan's `reconcile` turns them into events. A UID counts as
 * reported only once its envelope is, so a cold start between batches resumes where it stopped.
 *
 * Servers differ in what they can say. Expunges are found by comparing UID sets, because neither
 * Zoho nor Outlook offers QRESYNC. Flag changes come from CONDSTORE's CHANGEDSINCE where the server
 * has it, as Zoho does, and otherwise from comparing every flag in the window with those the
 * cursor keeps, as Outlook needs.
 */

/** What the server says about a folder once it is selected and searched for the sync window. */
export type FolderState = {
  uidValidity: number;
  uidNext: number;
  /** HIGHESTMODSEQ, which a server without CONDSTORE does not report. */
  highestModSeq?: bigint;
  /** Every UID inside the sync window, from `UID SEARCH SINCE`. */
  inWindow: readonly number[];
};

/** What to fetch for one batch, and how to make events of it. */
export type SyncPlan = {
  /** UIDs whose envelopes to fetch, newest first. */
  envelopes: number[];
  /**
   * How to learn of flag changes on messages already reported: the flags changed since a MODSEQ,
   * the flags of every message in the window, or nothing.
   */
  flags: { changedSince: bigint } | 'all' | 'none';
  /** This batch's events, the next cursor, and whether work remains beyond this batch. */
  reconcile(fetched: Fetched): { events: SyncEvent[]; cursor: string; more: boolean };
};

/** What the provider fetched for a plan. */
export type Fetched = {
  envelopes: readonly Envelope[];
  /** Flags by UID, when the plan asked for them. */
  flags?: ReadonlyMap<number, Flags>;
};

/**
 * At most this many messages arrive or leave in one batch, which keeps a batch's CPU bounded. A
 * folder starting over begins with a smaller batch, so its newest mail shows sooner.
 */
const BATCHES = { first: FIRST_SYNC_BATCH, rest: 500 };

/**
 * Compares the folder with the cursor. With no usable cursor, or when the server has numbered its
 * UIDs again, nothing counts as reported and the folder starts over.
 */
export function planSync(
  folder: FolderRef,
  cursor: string | null,
  state: FolderState,
  batches: { first: number; rest: number } = BATCHES,
): SyncPlan {
  const decoded = cursor === null ? undefined : decode(cursor);
  const known =
    decoded && decoded.uidValidity === state.uidValidity && decoded.uidNext <= state.uidNext
      ? decoded
      : undefined;

  const size = known ? batches.rest : batches.first;
  const inWindow = new Set(state.inWindow);
  const previously = known?.uids ?? [];
  const reported = new Set(previously.filter((uid) => inWindow.has(uid)));
  const allLeaving = previously.filter((uid) => !inWindow.has(uid));
  const leaving = allLeaving.slice(0, size);
  const unreported = new Set([...inWindow].filter((uid) => !reported.has(uid)));
  const arriving = [...unreported].sort((a, b) => b - a).slice(0, size - leaving.length);
  const more = allLeaving.length > leaving.length || unreported.size > arriving.length;

  const { account, path } = folder;
  const ref = (uid: number) => ({ account, path, uidValidity: state.uidValidity, uid });

  return {
    envelopes: arriving,
    flags: known ? flagsToFetch(known, state) : 'none',
    reconcile: (fetched) => {
      const arrived = new Map<number, Envelope>();
      for (const envelope of fetched.envelopes) {
        const wanted =
          envelope.account === account &&
          envelope.path === path &&
          envelope.uidValidity === state.uidValidity &&
          unreported.has(envelope.uid);
        if (wanted) arrived.set(envelope.uid, envelope);
      }

      const flags = new Map(known?.flags);
      const reflagged: SyncEvent[] = [];
      for (const [uid, current] of fetched.flags ?? []) {
        if (!reported.has(uid)) continue;
        const before = known?.flags?.get(uid);
        if (!before || !sameFlags(before, current)) {
          reflagged.push({ type: 'flags', ref: ref(uid), flags: current });
        }
        flags.set(uid, current);
      }
      for (const envelope of arrived.values()) flags.set(envelope.uid, envelope.flags);

      const events: SyncEvent[] = [
        ...(known ? [] : [{ type: 'reset', folder: { account, path } } as const]),
        ...leaving.map((uid): SyncEvent => ({ type: 'gone', ref: ref(uid) })),
        ...[...arrived.values()]
          .sort((a, b) => b.uid - a.uid)
          .map((envelope): SyncEvent => ({ type: 'message', envelope })),
        ...reflagged,
      ];

      const gone = new Set(leaving);
      const uids = [...previously.filter((uid) => !gone.has(uid)), ...arrived.keys()];
      const next: Remembered = {
        uidValidity: state.uidValidity,
        uidNext: state.uidNext,
        highestModSeq: state.highestModSeq,
        uids: uids.sort((a, b) => a - b),
        flags: state.highestModSeq === undefined ? flags : undefined,
      };
      return { events, cursor: encode(next), more };
    },
  };
}

/** Reads IMAP's system flags, which compare without regard to case. Keywords are ignored. */
export function flagsOf(imapFlags: Iterable<string>): Flags {
  const set = new Set([...imapFlags].map((flag) => flag.toLowerCase()));
  return {
    seen: set.has('\\seen'),
    flagged: set.has('\\flagged'),
    answered: set.has('\\answered'),
    draft: set.has('\\draft'),
  };
}

/** What the cursor remembers about a folder. */
type Remembered = {
  uidValidity: number;
  uidNext: number;
  highestModSeq: bigint | undefined;
  /** Every UID reported, ascending. */
  uids: number[];
  /** The flags of every UID reported, kept only for a server without CONDSTORE. */
  flags: Map<number, Flags> | undefined;
};

function flagsToFetch(known: Remembered, state: FolderState): SyncPlan['flags'] {
  if (known.uids.length === 0) return 'none';
  const { highestModSeq: since } = known;
  if (since === undefined || state.highestModSeq === undefined || since > state.highestModSeq) {
    return 'all';
  }
  return since === state.highestModSeq ? 'none' : { changedSince: since };
}

function sameFlags(a: Flags, b: Flags): boolean {
  return (
    a.seen === b.seen && a.flagged === b.flagged && a.answered === b.answered && a.draft === b.draft
  );
}

// The cursor. UIDs are stored as runs, and flags as runs over those UIDs, each run a variable-length
// number in base64url, so even a folder of 50,000 messages riddled with gaps stays under 64 KB.

const FLAG_NAMES = ['seen', 'flagged', 'answered', 'draft'] as const;

/** The cursor as stored. `v` changes whenever the shape does, and an older shape starts over. */
type Stored = {
  v: 1;
  uidValidity: number;
  uidNext: number;
  highestModSeq?: string;
  uids: string;
  flags?: Record<keyof Flags, string>;
};

function encode({ uidValidity, uidNext, highestModSeq, uids, flags }: Remembered): string {
  const stored: Stored = {
    v: 1,
    uidValidity,
    uidNext,
    highestModSeq: highestModSeq?.toString(),
    uids: packUids(uids),
    flags:
      flags &&
      (Object.fromEntries(
        FLAG_NAMES.map((name) => [
          name,
          packBits(uids.map((uid) => flags.get(uid)?.[name] ?? false)),
        ]),
      ) as Stored['flags']),
  };
  return JSON.stringify(stored);
}

/** The cursor's memory, or nothing when it is not a cursor this version wrote. */
function decode(cursor: string): Remembered | undefined {
  try {
    const stored = JSON.parse(cursor) as Stored;
    if (stored.v !== 1) return undefined;
    const uids = unpackUids(stored.uids);
    const bits =
      stored.flags && FLAG_NAMES.map((name) => unpackBits(stored.flags![name], uids.length));
    const flagsAt = (i: number) =>
      Object.fromEntries(FLAG_NAMES.map((name, f) => [name, bits![f]![i]!])) as Flags;
    return {
      uidValidity: stored.uidValidity,
      uidNext: stored.uidNext,
      highestModSeq: stored.highestModSeq === undefined ? undefined : BigInt(stored.highestModSeq),
      uids,
      flags: bits && new Map(uids.map((uid, i) => [uid, flagsAt(i)])),
    };
  } catch {
    return undefined;
  }
}

/** Ascending UIDs as pairs of numbers: the gap before a run, and the run's length less one. */
function packUids(uids: readonly number[]): string {
  const numbers: number[] = [];
  let previous = 0;
  for (let start = 0; start < uids.length;) {
    let end = start;
    while (uids[end + 1] === uids[end]! + 1) end++;
    numbers.push(uids[start]! - previous - 1, end - start);
    previous = uids[end]!;
    start = end + 1;
  }
  return toVlq(numbers);
}

function unpackUids(packed: string): number[] {
  const numbers = fromVlq(packed);
  if (numbers.length % 2) throw new Error('A run of UIDs has no length.');
  const uids: number[] = [];
  let previous = 0;
  for (let i = 0; i < numbers.length; i += 2) {
    const start = previous + numbers[i]! + 1;
    const length = numbers[i + 1]! + 1;
    for (let uid = start; uid < start + length; uid++) uids.push(uid);
    previous = start + length - 1;
  }
  return uids;
}

/** Booleans as the lengths of alternating runs, starting with a run of `false`. */
function packBits(bits: readonly boolean[]): string {
  const runs: number[] = [];
  let value = false;
  let run = 0;
  for (const bit of bits) {
    if (bit === value) run++;
    else {
      runs.push(run);
      value = bit;
      run = 1;
    }
  }
  return toVlq([...runs, run]);
}

function unpackBits(packed: string, length: number): boolean[] {
  const bits = fromVlq(packed).flatMap((run, i) => Array<boolean>(run).fill(i % 2 === 1));
  if (bits.length !== length) throw new Error('The flags do not cover every UID.');
  return bits;
}

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Non-negative numbers, five bits to a digit, with the sixth bit marking that more follow. */
function toVlq(numbers: readonly number[]): string {
  let text = '';
  for (let number of numbers) {
    do {
      const low = number % 32;
      number = Math.floor(number / 32);
      text += DIGITS[number > 0 ? low + 32 : low];
    } while (number > 0);
  }
  return text;
}

function fromVlq(text: string): number[] {
  const numbers: number[] = [];
  let number = 0;
  let scale = 1;
  for (const char of text) {
    const digit = DIGITS.indexOf(char);
    if (digit < 0) throw new Error(`"${char}" is not a cursor digit.`);
    number += (digit % 32) * scale;
    scale *= 32;
    if (digit < 32) {
      numbers.push(number);
      number = 0;
      scale = 1;
    }
  }
  if (scale !== 1) throw new Error('The cursor ends mid-number.');
  return numbers;
}
