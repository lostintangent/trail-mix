import { expect, test } from 'bun:test';
import type { Message, MessageRef } from '../../mail/core/index.ts';
import { hiddenIn, leftBySend } from './useComposing.ts';

const thread = 'thread-lunch';

test('a draft its composer saved is out of the first snapshot that holds it, before its save answers', () => {
  // The first save answered with uid 8. The second has made uid 9 and dropped 8, and a hint has
  // brought the conversation that holds it before the save itself answers.
  const writing = { in: thread, before: [], editing: draft(8) };
  const conversation = [message(1), message(9, true)];

  expect(uids(hiddenIn({ writing: [writing], gone: [] }, thread, conversation))).toContain(9);
});

test('the drafts its conversation held as the composer started stay in sight', () => {
  const writing = { in: thread, before: [draft(5)], editing: undefined };
  const conversation = [message(1), message(5, true), message(9, true)];

  expect(uids(hiddenIn({ writing: [writing], gone: [] }, thread, conversation))).toEqual([9]);
});

test('a draft sent from among the messages it answers leaves its conversation open', () => {
  const conversation = [message(1), message(9, true)];

  expect(
    leftBySend({ as: 'draft', draft: message(9, true), conversation }, thread, false, []),
  ).toBe(undefined);
});

test('a draft sent from a conversation it was alone in gives way to the next', () => {
  const conversation = [message(9, true)];

  expect(
    leftBySend({ as: 'draft', draft: message(9, true), conversation }, thread, false, []),
  ).toBe(thread);
});

test('in Drafts, a sent draft gives way once its conversation’s other drafts are on their way too', () => {
  const conversation = [message(1), message(5, true), message(9, true)];
  const compose = { as: 'draft', draft: message(9, true), conversation } as const;
  const sendingFive = { id: 'press-5', drafts: [draft(5)], closes: 0 };

  expect(leftBySend(compose, thread, true, [])).toBe(undefined);
  expect(leftBySend(compose, thread, true, [sendingFive])).toBe(thread);
  // Anywhere else its answered message still shows.
  expect(leftBySend(compose, thread, false, [sendingFive])).toBe(undefined);
});

function uids(refs: readonly MessageRef[]): number[] {
  return refs.map(({ uid }) => uid);
}

function draft(uid: number): MessageRef {
  return { account: 'personal', path: 'Drafts', uidValidity: 7, uid };
}

function message(uid: number, isDraft = false): Message {
  return {
    ...(isDraft ? draft(uid) : { account: 'personal', path: 'INBOX', uidValidity: 3, uid }),
    conversation: thread,
    messageId: `<${uid}@trailmix.test>`,
    references: [],
    date: '2026-11-13T09:00:00Z',
    from: { email: 'me@trailmix.test' },
    to: [],
    cc: [],
    subject: 'Lunch',
    preview: '',
    flags: { seen: true, flagged: false, answered: false, draft: isDraft },
    hasAttachments: false,
    verified: false,
  };
}
