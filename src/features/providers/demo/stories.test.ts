import { expect, test } from 'bun:test';
import { applySyncEvent, memoryIndex, oneClickUnsubscribe } from '../../mail/core/index.ts';
import {
  DEMO_SIGNERS,
  SEEDED_FOLDERS,
  seededMessage,
  seededSize,
  type DemoKind,
} from './stories.ts';

/** The benches' mailbox: an Inbox of 50,000 messages in each account. */
const BENCH_INBOX = 50_000;
const CREATED_AT = '2026-11-09T12:00:00.000Z';

/** The public demo's mailbox, as `wrangler.jsonc` sizes it: Work's Inbox is a tenth of Personal's. */
const DEMO_INBOX = { personal: 200, work: 20 };

/** Every message of a bench-sized mailbox, newest first. */
function mailbox(kind: DemoKind) {
  const size = seededSize(kind, BENCH_INBOX);
  return Array.from({ length: size }, (_, at) => seededMessage(kind, size, CREATED_AT, size - at)!);
}

test('no two seeded messages share a Message-ID', () => {
  for (const kind of ['personal', 'work'] as const) {
    const ids = mailbox(kind).map((message) => message.content().messageId);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test('each pull request and issue has its own number and its own thread, and newer ones are higher', () => {
  // Each account's GitHub mail is about a repository of its own, which numbers its threads alone.
  for (const kind of ['personal', 'work'] as const) {
    const roots = new Map<string, Set<string>>();
    const numbers = new Map<number, Set<string>>();
    const firsts: number[] = [];
    for (const message of mailbox(kind)) {
      const { subject, references } = message.content();
      const number = /\((?:PR|Issue) #(\d+)\)$/.exec(subject)?.[1];
      if (number === undefined) continue;
      const [root] = references;
      const title = subject.replace(/^Re: /, '');
      roots.set(root!, (roots.get(root!) ?? new Set()).add(title));
      numbers.set(Number(number), (numbers.get(Number(number)) ?? new Set()).add(root!));
      if (!subject.startsWith('Re: ')) firsts.push(Number(number));
    }
    expect(firsts.length).toBeGreaterThan(100);
    expect([...roots.values()].filter((titles) => titles.size > 1)).toEqual([]);
    expect([...numbers.entries()].filter(([, held]) => held.size > 1)).toEqual([]);
    expect(Math.min(...numbers.keys())).toBeGreaterThan(0);
    // Newest first, every thread's number is lower than the one before it.
    expect(firsts.every((number, at) => at === 0 || number < firsts[at - 1]!)).toBe(true);
  }
});

test('no two rows of the public demo share a subject and how their preview opens', () => {
  // Every list's rows are conversations, each shown by its latest message, so every row any list
  // could show is here: across both accounts, as the unified views mix them.
  const folders = (['personal', 'work'] as const).flatMap((account) =>
    SEEDED_FOLDERS[account].map((folder) => ({ account, ...folder })),
  );
  let index = memoryIndex(folders);
  for (const kind of ['personal', 'work'] as const) {
    const size = seededSize(kind, DEMO_INBOX[kind]);
    for (let uid = size; uid >= 1; uid--) {
      const message = seededMessage(kind, size, CREATED_AT, uid)!;
      const { folder: path, flags } = message;
      const envelope = { ...message.content(), account: kind, path, uidValidity: 1, uid, flags };
      index = index.apply(applySyncEvent(index, { type: 'message', envelope }));
    }
  }
  const rows = [...Map.groupBy(index.messages, ({ conversation }) => conversation).values()].map(
    (messages) => messages.toSorted((a, b) => b.date.localeCompare(a.date))[0]!,
  );
  // What a row shows of its preview, which is about its first 40 characters.
  const shown = Map.groupBy(rows, ({ subject, preview }) => `${subject}: ${preview.slice(0, 40)}`);
  expect([...shown].filter(([, alike]) => alike.length > 1).map(([row]) => row)).toEqual([]);
  expect(rows.length).toBeGreaterThan(200);
});

test('the demo’s verified list mail offers one-click unsubscribe, and its other mail doesn’t', () => {
  const offered = new Set<string>();
  for (const kind of ['personal', 'work'] as const) {
    const size = seededSize(kind, DEMO_INBOX[kind]);
    for (let uid = 1; uid <= size; uid++) {
      const message = seededMessage(kind, size, CREATED_AT, uid)!;
      const { from, list, verified } = message.content();
      const offer = oneClickUnsubscribe(message.raw(), DEMO_SIGNERS);
      expect({ uid, offers: offer !== undefined }).toEqual({ uid, offers: !!list && verified });
      if (offer) offered.add(from.email);
    }
  }
  expect(offered).toContain('hello@kernelweekly.example.com');
});
