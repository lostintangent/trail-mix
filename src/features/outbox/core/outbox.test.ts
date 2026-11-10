import { expect, test } from 'bun:test';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import {
  HOST_FILING_SECONDS,
  MISSING,
  RESTARTED,
  UNDO_SECONDS,
  begin,
  cancel,
  due,
  filed,
  nextWake,
  recover,
  retry,
  schedule,
  submitted,
  type Failure,
  type Filed,
} from './outbox.ts';

const T0 = Date.parse('2026-11-10T09:00:00.000Z');
/** The time `minutes` after nine. */
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
/** The time `seconds` after nine. */
const atSecond = (seconds: number) => at(seconds / 60);

const draft: MessageRef = { account: 'personal', path: 'Drafts', uidValidity: 7, uid: 42 };
const entry = (id: string) => ({
  id,
  draft,
  messageId: `<${id}@trailmix.invalid>`,
  to: [{ name: 'Mina Okafor', email: 'mina@example.com' }],
  subject: `About ${id}`,
});
/** A send scheduled ahead, to go at `sendAt`. */
const send = (id = 'one', sendAt = at(0)) => schedule(entry(id), at(-24 * 60), sendAt);

const refused: Failure = { error: '550 5.1.1 No such user here', passing: false };
const offline: Failure = { error: 'The connection to smtp.example.com timed out.', passing: true };

test('a send waits for its time, then submits, files, and leaves the Outbox', () => {
  const waiting = send('one', at(0.25));
  expect(waiting).toMatchObject({ state: 'waiting', attempts: 0, sendAt: at(0.25) });
  expect(nextWake([waiting])).toBe(at(0.25));
  expect(due([waiting], at(0.2))).toEqual([]);
  expect(due([waiting], at(0.25))).toEqual([{ step: 'submit', outgoing: waiting }]);

  const sending = begin(waiting);
  expect(sending.state).toBe('sending');
  expect(due([sending], at(1))).toEqual([]);

  const accepted = submitted(sending, 'sent', at(0.3));
  expect(accepted).toEqual({
    ...waiting,
    state: 'accepted',
    sendAt: at(0.3),
    acceptedAt: at(0.3),
    attempts: 0,
  });
  expect(due([accepted], at(0.3))).toEqual([
    { step: 'file', outgoing: accepted, waitForHost: true },
  ]);

  expect(filed(accepted, 'filed', at(0.3))).toBe('done');
});

test('Send waits out a ten-second undo window before it goes', () => {
  expect(UNDO_SECONDS).toBe(10);
  expect(schedule(entry('now'), at(0))).toEqual({
    ...entry('now'),
    sendAt: at(10 / 60),
    state: 'waiting',
    attempts: 0,
  });
});

test('a send scheduled ahead goes at its time, and never before the undo window closes', () => {
  expect(schedule(entry('later'), at(0), at(60)).sendAt).toBe(at(60));
  expect(schedule(entry('soon'), at(0), at(5 / 60)).sendAt).toBe(at(10 / 60));
  expect(schedule(entry('past'), at(0), at(-60)).sendAt).toBe(at(10 / 60));
});

test('undo inside the window gives back the draft untouched', () => {
  expect(cancel(send('now', at(0.25)), at(0.2))).toBe(draft);
  expect(cancel(send('tomorrow', at(24 * 60)), at(0))).toBe(draft);
});

test('once a send has begun, it cannot be undone', () => {
  const sending = begin(send());
  expect(() => cancel(sending, at(0))).toThrow('It is being sent, so it can’t be undone.');
  expect(() => cancel(submitted(sending, 'sent', at(0)), at(0))).toThrow('It has been sent.');
});

test('the undo window closes when a send comes due, before the Mailroom wakes to begin it', () => {
  const waiting = send('now', at(0.25));
  expect(() => cancel(waiting, at(0.25))).toThrow('It is being sent, so it can’t be undone.');
  const retrying = submitted(begin(waiting), offline, at(0.25));
  expect(cancel(retrying, at(1))).toBe(draft);
  expect(() => cancel(retrying, retrying.sendAt)).toThrow('It is being sent');
});

test('scheduled sends come due at their time, soonest first, with no one watching', () => {
  const nine = send('nine', at(0));
  const eight = send('eight', at(-60));
  const alsoNine = send('also-nine', at(0));
  const outbox = [nine, eight, alsoNine];
  expect(nextWake(outbox)).toBe(at(-60));
  expect(due(outbox, at(-30)).map(({ outgoing }) => outgoing.id)).toEqual(['eight']);
  expect(due(outbox, at(0)).map(({ outgoing }) => outgoing.id)).toEqual([
    'eight',
    'also-nine',
    'nine',
  ]);
});

test('a send the server refuses keeps its reason and waits for Retry, then succeeds', () => {
  const rejected = submitted(begin(send()), refused, at(0));
  expect(rejected).toMatchObject({ state: 'failed', attempts: 1, error: refused.error });
  expect(due([rejected], at(7 * 24 * 60))).toEqual([]);
  expect(nextWake([rejected])).toBeUndefined();
  expect(cancel(rejected, at(7 * 24 * 60))).toBe(rejected.draft);

  const again = retry(rejected, at(5));
  expect(again).toEqual({ ...send(), sendAt: at(5) });
  const accepted = submitted(begin(again), 'sent', at(5));
  expect(accepted.state).toBe('accepted');
  expect(filed(accepted, 'filed', at(5))).toBe('done');
});

test('a passing failure retries on its own after 1, 2, 4, 8, 16 and 32 minutes, then hourly, for a day', () => {
  let outgoing = send();
  let now = 0;
  const waits: number[] = [];
  while (outgoing.state === 'waiting') {
    outgoing = submitted(begin(outgoing), offline, at(now));
    if (outgoing.state !== 'waiting') break;
    expect(outgoing.error).toBe(offline.error);
    const next = (Date.parse(outgoing.sendAt) - Date.parse(at(now))) / 60_000;
    waits.push(next);
    now += next + 0.5;
  }
  expect(waits).toEqual([1, 2, 4, 8, 16, 32, ...Array<number>(22).fill(60)]);
  expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(24 * 60);
  expect(outgoing).toMatchObject({ state: 'failed', attempts: 29, error: offline.error });
});

test('a send accepted after failing files with a clean slate', () => {
  const retried = submitted(begin(send()), offline, at(0));
  const accepted = submitted(begin(retried), 'sent', at(1));
  expect(accepted).toEqual({
    ...send(),
    state: 'accepted',
    sendAt: at(1),
    acceptedAt: at(1),
    attempts: 0,
  });
  expect(filed(accepted, offline, at(1))).toMatchObject({ attempts: 1, sendAt: at(2) });
});

test('Retry on a send that is retrying on its own, or filing, tries it now', () => {
  const retrying = submitted(begin(send()), offline, at(0));
  expect(retry(retrying, at(0.5))).toEqual({ ...retrying, sendAt: at(0.5) });
  const filing = filed(submitted(begin(send()), 'sent', at(0)), offline, at(0)) as Outgoing;
  expect(retry(filing, at(0.5))).toEqual({ ...filing, sendAt: at(0.5) });
  expect(() => retry(begin(send()), at(0))).toThrow('It is being sent.');
});

test('a draft that is gone, and not in Sent, fails saying so and never counts as sent', () => {
  const gone = submitted(begin(send()), 'missing', at(0));
  expect(gone).toMatchObject({ state: 'failed', error: MISSING });
  expect(due([gone], at(60))).toEqual([]);
});

test('filing that fails retries on its own however long it takes, and never submits again', () => {
  let outgoing = submitted(begin(send()), 'sent', at(0));
  let now = 0;
  for (let failure = 1; failure <= 40; failure++) {
    const [next] = due([outgoing], at(now));
    expect(next?.step).toBe('file');
    outgoing = filed(outgoing, refused, at(now)) as Outgoing;
    expect(outgoing).toMatchObject({ state: 'accepted', attempts: failure, error: refused.error });
    now = (Date.parse(outgoing.sendAt) - T0) / 60_000;
  }
  expect(Date.parse(outgoing.sendAt) - Date.parse(at(now - 60))).toBe(60 * 60_000);
  expect(filed(outgoing, 'filed', at(now))).toBe('done');
});

test('filing leaves Sent to the host for two minutes, looking for its copy at 2, 4, 8, 16, 32 and 64 seconds', () => {
  expect(HOST_FILING_SECONDS).toBe(120);
  let outgoing = submitted(begin(send()), 'sent', at(0));
  const looks: number[] = [];
  for (;;) {
    const [next] = due([outgoing], outgoing.sendAt);
    if (next?.step !== 'file') throw new Error('Filing was not due when it said it would be.');
    looks.push((Date.parse(outgoing.sendAt) - T0) / 1000);
    if (!next.waitForHost) break;
    outgoing = filed(outgoing, 'unfiled', outgoing.sendAt) as Outgoing;
    expect(outgoing).toMatchObject({ state: 'accepted', acceptedAt: at(0), attempts: 0 });
    expect(nextWake([outgoing])).toBe(outgoing.sendAt);
  }
  expect(looks).toEqual([0, 2, 4, 8, 16, 32, 64, 120]);
  expect(filed(outgoing, 'filed', at(2))).toBe('done');
});

test('the wait for the host ends two minutes after acceptance, however the looks fall', () => {
  const accepted = submitted(begin(send()), 'sent', at(0));
  const waitsAt = (seconds: number) => {
    const [next] = due([accepted], atSecond(seconds));
    return next?.step === 'file' && next.waitForHost;
  };
  expect(waitsAt(119.999)).toBe(true);
  expect(waitsAt(120)).toBe(false);
  // A look that comes late, as a wake can, looks next no later than the wait's end, then not again.
  const late = filed(accepted, 'unfiled', atSecond(100)) as Outgoing;
  expect(late.sendAt).toBe(atSecond(120));
  expect((filed(accepted, 'unfiled', atSecond(130)) as Outgoing).sendAt).toBe(atSecond(130));
  // A send the Outbox accepted before it kept the time waits for no host.
  const { acceptedAt: _acceptedAt, ...before } = accepted;
  expect(due([before], at(0))).toEqual([{ step: 'file', outgoing: before, waitForHost: false }]);
});

test('a look that finds the host has not filed yet clears an earlier filing failure', () => {
  const failing = filed(submitted(begin(send()), 'sent', at(0)), offline, atSecond(1)) as Outgoing;
  expect(failing).toMatchObject({ attempts: 1, error: offline.error });
  const looking = filed(failing, 'unfiled', at(1)) as Outgoing;
  expect(looking).toMatchObject({ attempts: 0, sendAt: at(2) });
  expect(looking.error).toBeUndefined();
});

test('a send cut short by a restart is held as failed, saying it may have gone', () => {
  const waiting = send('waiting', at(10));
  const sending = begin(send('sending'));
  const accepted = submitted(begin(send('accepted')), 'sent', at(0));
  const rejected = submitted(begin(send('rejected')), refused, at(0));
  const [a, b, c, d] = recover([waiting, sending, accepted, rejected]);
  expect(a).toBe(waiting);
  expect(b).toEqual({ ...sending, state: 'failed', attempts: 1, error: RESTARTED });
  expect(c).toBe(accepted);
  expect(d).toBe(rejected);
});

test('each step happens only from its own state', () => {
  const sending = begin(send());
  const accepted = submitted(sending, 'sent', at(0));
  expect(() => begin(sending)).toThrow('A sending send cannot begin.');
  expect(() => begin(accepted)).toThrow('A accepted send cannot begin.');
  expect(() => submitted(send(), 'sent', at(0))).toThrow('A waiting send did not submit.');
  expect(() => filed(sending, 'filed', at(0))).toThrow('A sending send cannot be filed.');
});

// A Mailroom and a host, cut short at every point a restart can land.

/** The points where a Mailroom can stop, in the order a send passes them. */
const POINTS = [
  'before it begins',
  'once it has begun',
  'once the host has accepted it',
  'once the Outbox has recorded that',
  'once Sent has its copy',
  'once the draft is gone',
  'while it waits for the host’s copy',
] as const;
type Point = (typeof POINTS)[number];

class Restart extends Error {}

/**
 * Whether a host is known to file its own copy in Sent, and whether it does: a host Trail Mix files
 * for, one that files its own, and one known to file its own that has it turned off.
 */
type Host = { known: boolean; files: boolean };
const HOSTS: [string, Host][] = [
  ['a host Trail Mix files for', { known: false, files: false }],
  ['a host that files its own copy', { known: true, files: true }],
  ['a host whose own copies are turned off', { known: true, files: false }],
];

/**
 * A host as the provider contract describes it. `submit` checks Sent for the Message-ID before it
 * hands the host anything. `file` leaves Sent to a host known to file its own while it waits for
 * the host, and otherwise appends a copy only if Sent lacks one, then removes the draft. A host that
 * files its own copy does so a moment after it accepts.
 */
function host({ known, files }: Host, messageId: string) {
  const world = { drafts: new Set([messageId]), sent: [] as string[], delivered: 0 };
  let filing = false;
  return {
    world,
    /** Time passes, and a host that files its own copy has done so. */
    settle() {
      if (filing) world.sent.push(messageId);
      filing = false;
    },
    submit(stop: (point: Point) => void): 'sent' | 'missing' {
      if (world.sent.includes(messageId)) return 'sent';
      if (!world.drafts.has(messageId)) return 'missing';
      world.delivered++;
      filing = files;
      stop('once the host has accepted it');
      return 'sent';
    },
    file(stop: (point: Point) => void, fail: boolean, waitForHost: boolean): Filed {
      if (fail) return { error: 'NO [OVERQUOTA] Sent is full', passing: false };
      if (!world.sent.includes(messageId)) {
        if (known && waitForHost) return 'unfiled';
        world.sent.push(messageId);
      }
      stop('once Sent has its copy');
      world.drafts.delete(messageId);
      stop('once the draft is gone');
      return 'filed';
    },
  };
}

/** One wake of the Mailroom, driving the Outbox the way its documentation says to. */
function wake(
  outbox: Map<string, Outgoing>,
  server: ReturnType<typeof host>,
  now: string,
  stop: (point: Point) => void,
  failFiling: { once: boolean },
) {
  for (
    let next = due([...outbox.values()], now)[0];
    next;
    next = due([...outbox.values()], now)[0]
  ) {
    const { id } = next.outgoing;
    if (next.step === 'submit') {
      stop('before it begins');
      outbox.set(id, begin(next.outgoing));
      stop('once it has begun');
      outbox.set(id, submitted(outbox.get(id)!, server.submit(stop), now));
      stop('once the Outbox has recorded that');
    } else {
      const outcome = server.file(stop, failFiling.once, next.waitForHost);
      failFiling.once = false;
      const result = filed(next.outgoing, outcome, now);
      if (result === 'done') outbox.delete(id);
      else outbox.set(id, result);
      if (outcome === 'unfiled') stop('while it waits for the host’s copy');
    }
  }
}

/**
 * Sends one message, restarting the Mailroom once at `point`, and runs every wake that follows, a
 * minute apart.
 */
function sendThrough(point: Point | undefined, kind: Host, failFiling = false) {
  const scheduled = send();
  const server = host(kind, scheduled.messageId);
  let outbox = new Map([[scheduled.id, scheduled]]);
  let stopped = false;
  const stop = (reached: Point) => {
    if (reached === point && !stopped) {
      stopped = true;
      throw new Restart(reached);
    }
  };
  const failing = { once: failFiling };
  let minute = 0;
  for (let wakes = 0; wakes < 10; wakes++, minute += 1) {
    try {
      wake(outbox, server, at(minute), stop, failing);
    } catch (error) {
      if (!(error instanceof Restart)) throw error;
      outbox = new Map(recover([...outbox.values()]).map((entry) => [entry.id, entry]));
    }
    server.settle();
    // Never twice, and never a draft gone without its message having left.
    expect(server.world.delivered).toBeLessThanOrEqual(1);
    if (!server.world.drafts.has(scheduled.messageId)) expect(server.world.delivered).toBe(1);
  }
  return { outbox, server, entry: outbox.get(scheduled.id), minute };
}

for (const [name, kind] of HOSTS) {
  test(`on ${name}, a restart before a send begins, once its acceptance is recorded, or while it waits, still sends it once`, () => {
    for (const point of [undefined, ...POINTS]) {
      if (point === 'once the host has accepted it' || point === 'once it has begun') continue;
      const { entry, server } = sendThrough(point, kind);
      expect({ point, entry }).toEqual({ point, entry: undefined });
      expect({ point, ...server.world }).toEqual({
        point,
        drafts: new Set(),
        sent: [send().messageId],
        delivered: 1,
      });
    }
  });

  test(`on ${name}, a restart while it submits holds the send as failed, draft and all`, () => {
    for (const point of ['once it has begun', 'once the host has accepted it'] as const) {
      const { entry, server } = sendThrough(point, kind);
      expect(entry).toMatchObject({ state: 'failed', error: RESTARTED });
      expect(server.world.drafts.has(send().messageId)).toBe(true);
      expect(server.world.delivered).toBe(point === 'once it has begun' ? 0 : 1);
    }
  });

  test(`on ${name}, a failed filing after acceptance files later and delivers nothing again`, () => {
    const { entry, server } = sendThrough(undefined, kind, true);
    expect(entry).toBeUndefined();
    expect(server.world).toEqual({ drafts: new Set(), sent: [send().messageId], delivered: 1 });
  });
}

test('after a restart cut it short, Retry finds the copy a host filed itself and does not send again', () => {
  const { outbox, server, minute } = sendThrough('once the host has accepted it', HOSTS[1]![1]);
  const held = [...outbox.values()][0]!;
  outbox.set(held.id, retry(held, at(minute)));
  wake(outbox, server, at(minute), () => {}, { once: false });
  expect(outbox.size).toBe(0);
  expect(server.world).toEqual({ drafts: new Set(), sent: [send().messageId], delivered: 1 });
});
