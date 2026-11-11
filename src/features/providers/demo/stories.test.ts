import { expect, test } from 'bun:test';
import { seededMessage, seededSize, type DemoKind } from './stories.ts';

/** The benches' mailbox: an Inbox of 50,000 messages in each account. */
const BENCH_INBOX = 50_000;
const CREATED_AT = '2026-11-09T12:00:00.000Z';

/** The public demo's mailbox, as `wrangler.jsonc` sizes it: Work's Inbox is a tenth of Personal's. */
const DEMO_INBOX = { personal: 200, work: 20 };

/** More rows of a list than any screen shows at once. */
const SCREENFUL = 30;

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

test('the public demo never shows two messages alike within a screenful of a folder', () => {
  // Alike as a row shows them: saying the same, or opening the same way under the same subject.
  const alike: string[] = [];
  for (const kind of ['personal', 'work'] as const) {
    const size = seededSize(kind, DEMO_INBOX[kind]);
    const newestFirst = Array.from({ length: size }, (_, at) =>
      seededMessage(kind, size, CREATED_AT, size - at)!,
    );
    for (const [folder, messages] of Map.groupBy(newestFirst, ({ folder }) => folder)) {
      const rows = messages.map((message) => {
        const { subject, preview } = message.content();
        return { subject: subject.replace(/^Re: /, ''), preview, opening: preview.slice(0, 40) };
      });
      rows.forEach((row, at) => {
        for (const other of rows.slice(at + 1, at + SCREENFUL)) {
          if (
            row.preview === other.preview ||
            (row.subject === other.subject && row.opening === other.opening)
          ) {
            alike.push(`${kind} ${folder}: ${row.subject}: ${row.opening}`);
          }
        }
      });
    }
  }
  expect(alike).toEqual([]);
});
