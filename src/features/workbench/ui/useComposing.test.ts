import { expect, test } from 'bun:test';
import type { Message, MessageRef } from '../../mail/core/index.ts';
import { hiddenIn } from './useComposing.ts';

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
