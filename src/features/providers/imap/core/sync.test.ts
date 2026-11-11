import { expect, test } from 'bun:test';
import {
  applySyncEvent,
  memoryIndex,
  type Envelope,
  type Flags,
  type MemoryIndex,
} from '../../../mail/core/index.ts';
import { seededRandom } from '../../../../shared/random.ts';
import { flagsOf, planSync, type FolderState, type SyncPlan } from './sync.ts';

const INBOX = { account: 'personal', path: 'INBOX' };
const LAST_YEAR = '2025-11-10T00:00:00.000Z';

const unread: Flags = { seen: false, flagged: false, answered: false, draft: false };
const read: Flags = { ...unread, seen: true };

/**
 * A folder on an IMAP server, faithful to what the protocol promises: UIDs only grow, UIDVALIDITY
 * changes when they start over, and every flag change raises the folder's MODSEQ.
 */
class Mailbox {
  uidValidity = 1;
  uidNext = 1;
  modSeq = 1n;
  readonly messages = new Map<number, { envelope: Envelope; modSeq: bigint }>();

  deliver(date = '2026-11-09T12:00:00.000Z', flags = unread): number {
    const uid = this.uidNext++;
    this.messages.set(uid, {
      envelope: message(this.uidValidity, uid, date, flags),
      modSeq: ++this.modSeq,
    });
    return uid;
  }

  flag(uid: number, flags: Flags) {
    const stored = this.messages.get(uid)!;
    this.messages.set(uid, { envelope: { ...stored.envelope, flags }, modSeq: ++this.modSeq });
  }

  expunge(uid: number) {
    this.messages.delete(uid);
  }

  /** What `doveadm` does to force a UIDVALIDITY change: the same mail, numbered again. */
  renumber() {
    const envelopes = [...this.messages.values()].map(({ envelope }) => envelope);
    this.messages.clear();
    this.uidValidity++;
    this.uidNext = 1;
    for (const { date, flags } of envelopes) this.deliver(date, flags);
  }
}

type Server = { condstore: boolean; since?: string; batchSize?: number };

/** One call of the provider's `sync`: select and search, plan, fetch what the plan names, reconcile. */
function sync(mailbox: Mailbox, cursor: string | null, server: Server = ZOHO) {
  const window = [...mailbox.messages].filter(
    ([, { envelope }]) => envelope.date >= (server.since ?? LAST_YEAR),
  );
  const state: FolderState = {
    uidValidity: mailbox.uidValidity,
    uidNext: mailbox.uidNext,
    highestModSeq: server.condstore ? mailbox.modSeq : undefined,
    inWindow: window.map(([uid]) => uid),
  };
  const plan = planSync(
    INBOX,
    cursor,
    state,
    server.batchSize === undefined
      ? undefined
      : { first: server.batchSize, rest: server.batchSize },
  );
  const envelopes = plan.envelopes.flatMap((uid) => mailbox.messages.get(uid)?.envelope ?? []);
  const flags = fetchFlags(
    mailbox,
    plan.flags,
    window.map(([uid]) => uid),
  );
  return { plan, ...plan.reconcile({ envelopes, flags }) };
}

function fetchFlags(mailbox: Mailbox, asked: SyncPlan['flags'], inWindow: number[]) {
  if (asked === 'none') return undefined;
  // CHANGEDSINCE runs over the whole folder, so it can name messages outside the window.
  const uids = asked === 'all' ? inWindow : [...mailbox.messages.keys()];
  return new Map(
    uids
      .map((uid) => [uid, mailbox.messages.get(uid)!] as const)
      .filter(([, stored]) => asked === 'all' || stored.modSeq > asked.changedSince)
      .map(([uid, stored]) => [uid, stored.envelope.flags]),
  );
}

const ZOHO: Server = { condstore: true };
const OUTLOOK: Server = { condstore: false };

/** What the Mailroom does with a sync: fold its events and keep its cursor, together. */
class Mailroom {
  index: MemoryIndex = memoryIndex([{ ...INBOX, role: 'inbox' }]);
  cursor: string | null = null;

  constructor(private readonly server: Server = ZOHO) {}

  /** One batch. A cold start can happen after any of them, and only the cursor survives it. */
  step(mailbox: Mailbox) {
    const result = sync(mailbox, this.cursor, this.server);
    for (const event of result.events)
      this.index = this.index.apply(applySyncEvent(this.index, event));
    this.cursor = result.cursor;
    return result;
  }

  catchUp(mailbox: Mailbox) {
    while (this.step(mailbox).more);
    return this;
  }
}

/** The index should hold exactly the window's messages, with the server's flags. */
function mirrors(mailroom: Mailroom, mailbox: Mailbox, since = LAST_YEAR) {
  const held = mailroom.index.messages.map(({ uidValidity, uid, flags }) => ({
    uidValidity,
    uid,
    flags,
  }));
  const window = [...mailbox.messages.values()]
    .filter(({ envelope }) => envelope.date >= since)
    .map(({ envelope: { uidValidity, uid, flags } }) => ({ uidValidity, uid, flags }));
  const byUid = (a: { uid: number }, b: { uid: number }) => a.uid - b.uid;
  expect(held.sort(byUid)).toEqual(window.sort(byUid));
}

test('a first sync reports the folder newest first, a small batch and then full ones, each surviving a cold start', () => {
  const mailbox = new Mailbox();
  for (let i = 0; i < 1200; i++) mailbox.deliver();

  const first = sync(mailbox, null);
  const resumed = sync(mailbox, first.cursor);
  const again = sync(mailbox, resumed.cursor);
  const last = sync(mailbox, again.cursor);

  expect(first.events[0]).toEqual({ type: 'reset', folder: INBOX });
  expect(uidsOf(first.events)).toEqual(range(1200, 1101));
  expect(uidsOf(resumed.events)).toEqual(range(1100, 601));
  expect(uidsOf(again.events)).toEqual(range(600, 101));
  expect(uidsOf(last.events)).toEqual(range(100, 1));
  expect([first.more, resumed.more, again.more, last.more]).toEqual([true, true, true, false]);
});

test('a folder numbered again starts over with a small batch too', () => {
  const mailbox = new Mailbox();
  for (let i = 0; i < 300; i++) mailbox.deliver();
  let batch = sync(mailbox, null);
  while (batch.more) batch = sync(mailbox, batch.cursor);
  mailbox.renumber();
  const restarted = sync(mailbox, batch.cursor);
  expect(restarted.events[0]).toEqual({ type: 'reset', folder: INBOX });
  expect(uidsOf(restarted.events)).toHaveLength(100);
});

test('a quiet folder fetches no envelopes, and reports nothing', () => {
  const mailbox = new Mailbox();
  mailbox.deliver();

  for (const server of [ZOHO, OUTLOOK]) {
    const { cursor } = sync(mailbox, null, server);
    const quiet = sync(mailbox, cursor, server);

    expect(quiet.plan.envelopes).toEqual([]);
    expect(quiet.events).toEqual([]);
    expect(quiet.more).toBe(false);
  }
  // With CONDSTORE, not even the flags.
  expect(sync(mailbox, sync(mailbox, null).cursor).plan.flags).toBe('none');
});

test('with CONDSTORE and no QRESYNC, new mail, expunges and flag changes each come out once', () => {
  const mailbox = new Mailbox();
  const [kept, expunged] = [mailbox.deliver(), mailbox.deliver()];
  const mailroom = new Mailroom(ZOHO).catchUp(mailbox);
  const before = mailbox.modSeq;

  mailbox.expunge(expunged);
  mailbox.flag(kept, read);
  const arrived = mailbox.deliver();
  const { plan, events } = mailroom.step(mailbox);

  expect(plan.envelopes).toEqual([arrived]);
  expect(plan.flags).toEqual({ changedSince: before });
  expect(events.map((event) => event.type)).toEqual(['gone', 'message', 'flags']);
  mirrors(mailroom, mailbox);
});

test('without CONDSTORE, every flag is compared and only real changes are reported', () => {
  const mailbox = new Mailbox();
  const [changed] = [mailbox.deliver(), mailbox.deliver(), mailbox.deliver()];
  const mailroom = new Mailroom(OUTLOOK).catchUp(mailbox);

  mailbox.flag(changed, read);
  const { plan, events } = mailroom.step(mailbox);

  expect(plan.flags).toBe('all');
  expect(events).toEqual([
    { type: 'flags', ref: { ...INBOX, uidValidity: 1, uid: changed }, flags: read },
  ]);
  expect(mailroom.step(mailbox).events).toEqual([]);
});

test('when the server numbers its UIDs again, the folder is forgotten and reported afresh', () => {
  const mailbox = new Mailbox();
  mailbox.deliver();
  mailbox.deliver();
  const mailroom = new Mailroom().catchUp(mailbox);

  mailbox.renumber();
  const { events } = mailroom.step(mailbox);

  expect(events.map((event) => event.type)).toEqual(['reset', 'message', 'message']);
  mirrors(mailroom, mailbox);
});

test('a server whose UIDNEXT went backwards is not trusted with the UIDs it reported', () => {
  const mailbox = new Mailbox();
  mailbox.deliver();
  mailbox.deliver();
  const mailroom = new Mailroom().catchUp(mailbox);

  // The server lost its state and hands out UID 1 again, to a different message.
  mailbox.messages.clear();
  mailbox.uidNext = 1;
  mailbox.deliver(undefined, read);

  expect(mailroom.step(mailbox).events[0]).toEqual({ type: 'reset', folder: INBOX });
  mirrors(mailroom, mailbox);
});

test('a cursor this version cannot read starts the folder over', () => {
  const mailbox = new Mailbox();
  mailbox.deliver();

  for (const cursor of ['', '{"v":2}', '{"v":1,"uidValidity":1,"uidNext":2,"uids":"!"}']) {
    const { events } = sync(mailbox, cursor);
    expect(events.map((event) => event.type)).toEqual(['reset', 'message']);
  }
});

test('mail ageing out of the window is gone, and mail the window takes in arrives', () => {
  const mailbox = new Mailbox();
  const older = mailbox.deliver('2025-06-01T00:00:00.000Z');
  const old = mailbox.deliver('2025-12-01T00:00:00.000Z');
  const mailroom = new Mailroom().catchUp(mailbox);

  const narrower = new Mailroom({ ...ZOHO, since: '2026-01-01T00:00:00.000Z' });
  narrower.cursor = mailroom.cursor;
  narrower.index = mailroom.index;
  expect(narrower.step(mailbox).events).toEqual([
    { type: 'gone', ref: { ...INBOX, uidValidity: 1, uid: old } },
  ]);

  const wider = new Mailroom({ ...ZOHO, since: '2025-01-01T00:00:00.000Z' });
  wider.cursor = narrower.cursor;
  wider.index = narrower.index;
  expect(uidsOf(wider.step(mailbox).events)).toEqual([old, older]);
});

test('an envelope the server did not return is asked for again, and none it was not asked for counts', () => {
  const mailbox = new Mailbox();
  const [missing, returned] = [mailbox.deliver(), mailbox.deliver()];
  const state = { uidValidity: 1, uidNext: 3, highestModSeq: mailbox.modSeq, inWindow: [1, 2] };
  const stranger = { ...mailbox.messages.get(returned)!.envelope, path: 'Sent' };

  const first = planSync(INBOX, null, state).reconcile({
    envelopes: [mailbox.messages.get(returned)!.envelope, stranger],
  });

  expect(uidsOf(first.events)).toEqual([returned]);
  expect(first.more).toBe(false);
  expect(planSync(INBOX, first.cursor, state).envelopes).toEqual([missing]);
});

test('a folder of 50,000 messages riddled with gaps keeps a cursor under 64 KB, flags and all', () => {
  const random = seededRandom(7);
  // Moving and deleting leaves a gap after roughly every third message, and most mail is read.
  const envelopes = Array.from({ length: 80_000 }, (_, i) =>
    message(1, i + 1, '2026-11-09T12:00:00.000Z', random() < 0.97 ? read : unread),
  ).filter(() => random() >= 0.375);
  const state = { uidValidity: 1, uidNext: 80_001, inWindow: envelopes.map(({ uid }) => uid) };

  // The whole folder in one batch, so the test measures the cursor rather than a hundred syncs.
  const whole = { first: envelopes.length, rest: envelopes.length };
  const { cursor, more } = planSync(INBOX, null, state, whole).reconcile({ envelopes });

  expect(more).toBe(false);
  expect(envelopes.length).toBeGreaterThan(49_000);
  expect(cursor.length).toBeLessThan(64 * 1024);
});

test('IMAP flags are read without regard to case, and keywords are left out', () => {
  expect(flagsOf(['\\SEEN', '\\flagged', '$Forwarded', 'Answered'])).toEqual({
    seen: true,
    flagged: true,
    answered: false,
    draft: false,
  });
});

test('whatever the server does between cold starts, syncing until done mirrors its window', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const random = seededRandom(seed);
    // Batches of a few messages, so a few dozen messages take many batches.
    const server = {
      ...(random() < 0.5 ? ZOHO : OUTLOOK),
      batchSize: 1 + Math.floor(random() * 6),
    };
    const mailbox = new Mailbox();
    const mailroom = new Mailroom(server);
    const pick = () => [...mailbox.messages.keys()][Math.floor(random() * mailbox.messages.size)];

    for (let step = 0; step < 40; step++) {
      const roll = random();
      if (roll < 0.35) {
        const count = Math.floor(random() * 8);
        for (let i = 0; i < count; i++)
          mailbox.deliver(random() < 0.2 ? '2025-01-01T00:00:00.000Z' : undefined);
      } else if (roll < 0.55) {
        const uid = pick();
        if (uid) mailbox.flag(uid, { ...unread, seen: random() < 0.5, flagged: random() < 0.5 });
      } else if (roll < 0.7) {
        const uid = pick();
        if (uid) mailbox.expunge(uid);
      } else if (roll < 0.75) mailbox.renumber();
      // A sync that may stop after any batch, as a deploy or an eviction would stop it.
      else
        for (
          let batch = Math.floor(random() * 3);
          batch > 0 && mailroom.step(mailbox).more;
          batch--
        );
    }

    mirrors(mailroom.catchUp(mailbox), mailbox);
  }
});

function message(uidValidity: number, uid: number, date: string, flags: Flags): Envelope {
  return {
    ...INBOX,
    uidValidity,
    uid,
    messageId: `<${uidValidity}.${uid}@example.com>`,
    references: [],
    from: { email: 'ada@example.com' },
    to: [{ email: 'me@trailmix.test' }],
    cc: [],
    subject: `Message ${uid}`,
    date,
    preview: '',
    flags,
    hasAttachments: false,
    verified: false,
  };
}

function uidsOf(events: readonly { type: string; envelope?: Envelope }[]): number[] {
  return events.flatMap((event) => (event.type === 'message' ? [event.envelope!.uid] : []));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: from - to + 1 }, (_, i) => from - i);
}
