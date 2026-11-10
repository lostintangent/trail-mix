import { expect, test } from 'bun:test';
import { gatheringOf, linkConversations } from './conversations.ts';
import { applySyncEvent, memoryIndex, type MemoryIndex, type SyncEvent } from './fold.ts';
import type { Envelope, Message } from './model.ts';
import { FOLDERS, arrive, envelope, fold, threads } from './testFixtures.ts';
import { seededRandom } from '../../../shared/random.ts';

const NOTHING = { put: [], remove: [] };

const read = { seen: true, flagged: false, answered: false, draft: false };

test('a flag change rewrites that message alone', () => {
  const question = envelope('question');
  const index = fold(arrive(question, envelope('answer', { references: [question.messageId] })));

  const change = applySyncEvent(index, { type: 'flags', ref: question, flags: read });

  expect(change).toEqual({ put: [{ ...index.message(question)!, flags: read }], remove: [] });
});

test('a message the index already holds can only change its flags', () => {
  const question = envelope('question');
  const index = fold(arrive(question));

  const again = { ...question, subject: 'edited', flags: read };

  expect(applySyncEvent(index, { type: 'message', envelope: again }).put).toEqual([
    { ...index.message(question)!, flags: read },
  ]);
});

test('events about messages the index never held change nothing', () => {
  const index = fold(arrive(envelope('held')));
  const stranger = envelope('stranger');

  expect(applySyncEvent(index, { type: 'flags', ref: stranger, flags: read })).toEqual(NOTHING);
  expect(applySyncEvent(index, { type: 'gone', ref: stranger })).toEqual(NOTHING);
  expect(
    applySyncEvent(index, { type: 'reset', folder: { account: 'personal', path: 'Junk' } }),
  ).toEqual(NOTHING);
});

test('folding any event a second time changes nothing', () => {
  const question = envelope('question');
  const answer = envelope('answer', { path: 'Sent', references: [question.messageId] });
  const events: SyncEvent[] = [
    ...arrive(question, answer, envelope('other')),
    { type: 'flags', ref: question, flags: read },
    { type: 'gone', ref: question },
    { type: 'reset', folder: { account: 'personal', path: 'Sent' } },
  ];

  let index = memoryIndex(FOLDERS);
  for (const event of events) {
    index = index.apply(applySyncEvent(index, event));
    expect(applySyncEvent(index, event)).toEqual(NOTHING);
  }
});

test('removing the message that links a conversation splits it as if it had never arrived', () => {
  const lunch = envelope('lunch');
  const dinner = envelope('dinner');
  const both = envelope('both', { references: [lunch.messageId, dinner.messageId] });

  const index = fold([...arrive(lunch, both, dinner), { type: 'gone', ref: both }]);

  expect(threads(index)).toEqual([['dinner'], ['lunch']]);
  expect(sorted(index)).toEqual(sorted(fold(arrive(lunch, dinner))));
});

test('a reset forgets the folder at every UIDVALIDITY and leaves its conversations to the rest', () => {
  const question = envelope('question');
  const index = fold(
    arrive(
      question,
      envelope('before the reset', { uidValidity: 7 }),
      envelope('answer', { path: 'Sent', references: [question.messageId] }),
      envelope('elsewhere', { account: 'work' }),
    ),
  );

  const after = fold([{ type: 'reset', folder: { account: 'personal', path: 'INBOX' } }], index);

  expect(threads(after)).toEqual([['answer'], ['elsewhere']]);
  expect(after.message(question)).toBeUndefined();
});

// Properties over generated mailboxes. Each seed builds a small mailbox whose messages share,
// repeat, omit and cycle their Message-IDs, across both accounts and every kind of folder.

const SEEDS = Array.from({ length: 200 }, (_, seed) => seed + 1);

test('the same messages, arriving in any order and any number of times, make the same index', () => {
  for (const seed of SEEDS) {
    const random = seededRandom(seed);
    const envelopes = mailbox(random);
    const arrivals = arrive(...envelopes, ...envelopes.filter(() => random() < 0.3));

    const index = fold(shuffled(arrivals, random));

    expect(sorted(index)).toEqual(sorted(fold(arrivals)));
    expect(sorted(index)).toEqual(linkedFromScratch(envelopes));
  }
});

test('removing messages, in any order, leaves the index as if they had never arrived', () => {
  for (const seed of SEEDS) {
    const random = seededRandom(seed);
    const envelopes = mailbox(random);
    const leaving = envelopes.filter(() => random() < 0.4);
    const staying = envelopes.filter((envelope) => !leaving.includes(envelope));
    const gone = leaving.map((ref): SyncEvent => ({ type: 'gone', ref }));

    const index = fold(shuffled(gone, random), fold(arrive(...envelopes)));

    expect(sorted(index)).toEqual(linkedFromScratch(staying));
  }
});

/** What the index should hold: every message, linked in one pass over all of them. */
function linkedFromScratch(envelopes: readonly Envelope[]): Message[] {
  const roleOf = (envelope: Envelope) =>
    FOLDERS.find((folder) => folder.account === envelope.account && folder.path === envelope.path)
      ?.role;
  const groups = Map.groupBy(envelopes, (envelope) =>
    JSON.stringify([envelope.account, gatheringOf(envelope, roleOf(envelope))]),
  );
  const messages = [...groups].flatMap(([key, group]) => {
    const [account, gathering] = JSON.parse(key) as [string, string];
    const ids = linkConversations(account, gathering, group);
    return group.map((envelope, i) => ({ ...envelope, conversation: ids[i]! }));
  });
  return sorted(memoryIndex(FOLDERS, messages));
}

/** Up to 30 messages whose ids and references draw from a small shared pool. */
function mailbox(random: () => number): Envelope[] {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const ids = Array.from({ length: 12 }, (_, i) => `<${i}@example.com>`);
  return Array.from({ length: 5 + Math.floor(random() * 25) }, (_, i) => {
    const folder = pick(FOLDERS);
    return envelope(`message ${i}`, {
      account: folder.account,
      path: folder.path,
      messageId: random() < 0.1 ? '' : pick(ids),
      references: Array.from({ length: Math.floor(random() * 4) }, () => pick(ids)),
    });
  });
}

function sorted(index: MemoryIndex): Message[] {
  const key = (message: Message) => JSON.stringify([message.account, message.path, message.uid]);
  return [...index.messages].sort((a, b) => key(a).localeCompare(key(b)));
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
