import { expect, test } from 'bun:test';
import { seededMessage, seededSize, type DemoKind } from './stories.ts';

/** The benches' mailbox: an Inbox of 50,000 messages in each account. */
const BENCH_INBOX = 50_000;
const CREATED_AT = '2026-11-09T12:00:00.000Z';

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

test('each pull request has its own number and its own thread, and newer ones are higher', () => {
  const roots = new Map<string, Set<string>>();
  const numbers = new Map<number, Set<string>>();
  const firsts: number[] = [];
  for (const message of mailbox('personal')) {
    const { subject, references } = message.content();
    const number = /\(PR #(\d+)\)$/.exec(subject)?.[1];
    if (number === undefined) continue;
    const [root] = references;
    const title = subject.replace(/^Re: /, '');
    roots.set(root!, (roots.get(root!) ?? new Set()).add(title));
    numbers.set(Number(number), (numbers.get(Number(number)) ?? new Set()).add(root!));
    if (!subject.startsWith('Re: ')) firsts.push(Number(number));
  }
  expect([...roots.values()].filter((titles) => titles.size > 1)).toEqual([]);
  expect([...numbers.entries()].filter(([, held]) => held.size > 1)).toEqual([]);
  expect(Math.min(...numbers.keys())).toBeGreaterThan(0);
  // Newest first, every pull request's number is lower than the one before it.
  expect(firsts.every((number, at) => at === 0 || number < firsts[at - 1]!)).toBe(true);
});
