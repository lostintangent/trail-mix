import { expect, test } from 'bun:test';
import type { Message, Outgoing } from '../../mail/core/index.ts';
import {
  draftsAway,
  expire,
  forget,
  GONE_MS,
  leavingIn,
  nextExpiry,
  observe,
  press,
  standingOfLeaving,
} from './leaving.ts';
import { begin, filed, schedule, submitted } from './outbox.ts';
import { closesAt } from './standing.ts';

const T0 = Date.parse('2026-11-10T09:00:00.000Z');
/** The time `seconds` after nine. */
const at = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const draft = { account: 'personal', path: 'Drafts', uidValidity: 7, uid: 42 };
const messageId = '<reply@trailmix.invalid>';
const thread = 'thread-lunch';
const parent = message({ uid: 3, path: 'INBOX', messageId: '<lunch@example.com>' });
/** The draft as the index holds it, in the conversation it answers. */
const indexed = message({ ...draft, messageId, preview: 'Thursday works. See you there.' }, true);
/** The copy in Sent, once the index has it. */
const copy = message({
  path: 'Sent',
  uid: 9,
  messageId,
  preview: 'Thursday works. See you there.',
});

const outgoing = (sendAt = iso(10)): Outgoing => ({
  ...schedule({ id: 'one', draft, messageId, to: [], subject: 'Lunch' }, iso(0), sendAt),
  conversation: thread,
});
const closesFor = closesAt;
const pressed = press([], {
  draft,
  pressedIn: thread,
  written: 'Thursday works.\n\n> On Monday, Mina wrote:\n> Lunch?\nSee you there.',
  pressedAt: at(0),
  at: undefined,
});

test('a reply pressed is on its way at once, at the end of its conversation, as it was written', () => {
  expect(leavingIn(pressed, thread, [parent])).toEqual([
    { leaving: pressed[0]!, preview: 'Thursday works. See you there.' },
  ]);
  expect(standingOfLeaving(pressed[0]!, at(1))).toEqual({ is: 'counting', seconds: 9 });
  expect(draftsAway(pressed)).toEqual([draft]);
  expect(leavingIn(pressed, 'another-thread', [parent])).toEqual([]);
});

test('a reply pressed for later waits for its time', () => {
  const later = press([], { ...pressedWith(), at: iso(3600) });
  expect(standingOfLeaving(later[0]!, at(1))).toEqual({ is: 'scheduled', at: iso(3600) });
});

test('a press the Mailroom refused is forgotten, and its draft is a draft again', () => {
  const refused = forget(pressed, draft);
  expect(leavingIn(refused, thread, [parent, indexed])).toEqual([]);
  expect(draftsAway(refused)).toEqual([]);
});

test('a snapshot older than a press leaves it on its way', () => {
  expect(observe(pressed, [], at(0.1), closesFor)).toEqual(pressed);
});

test('a send asked for elsewhere is on its way in the conversation the Outbox names', () => {
  const all = observe([], [outgoing()], at(1), closesFor);
  expect(leavingIn(all, thread, [parent, indexed])).toEqual([
    { leaving: all[0]!, preview: 'Thursday works. See you there.' },
  ]);
  expect(standingOfLeaving(all[0]!, at(1))).toEqual({ is: 'counting', seconds: 9 });
  expect(draftsAway(all)).toEqual([draft]);
});

test('a reply that went keeps its place until its copy comes, which takes it in one snapshot', () => {
  let all = observe(pressed, [outgoing()], at(1), closesFor);
  all = observe(all, [begin(outgoing())], at(10.5), closesFor);
  const accepted = submitted(begin(outgoing()), 'sent', iso(11));
  all = observe(all, [accepted], at(11), closesFor);
  expect(standingOfLeaving(all[0]!, at(11))).toEqual({ is: 'sent' });
  expect(filed(accepted, 'filed', iso(12))).toBe('done');
  all = observe(all, [], at(12), closesFor);
  // The draft is gone from the server, and Sent's copy not yet in the index.
  expect(leavingIn(all, thread, [parent])).toHaveLength(1);
  expect(standingOfLeaving(all[0]!, at(13))).toEqual({ is: 'sent' });
  expect(leavingIn(all, thread, [parent, copy])).toEqual([]);
});

test('a draft with its Message-ID is no copy, and a copy can be known by its draft’s', () => {
  expect(leavingIn(pressed, thread, [parent, indexed])).toHaveLength(1);
  expect(leavingIn(pressed, thread, [parent, indexed, copy])).toEqual([]);
});

test('a reply undone is forgotten with the snapshot that shows it gone, and its draft is back', () => {
  let all = observe(pressed, [outgoing()], at(1), closesFor);
  all = observe(all, [], at(4), closesFor);
  expect(all).toEqual([]);
  expect(draftsAway(all)).toEqual([]);
});

test('a failed send leaves its conversation for the Outbox, and giving it up forgets it', () => {
  const refused = { error: '554 refused', passing: false };
  const failed = submitted(begin(outgoing()), refused, iso(11));
  let all = observe(pressed, [failed], at(11), closesFor);
  expect(leavingIn(all, thread, [parent, indexed])).toEqual([]);
  expect(draftsAway(all)).toEqual([]);
  all = observe(all, [], at(20), closesFor);
  expect(all).toEqual([]);
});

test('a draft sent again after its send failed lies at the end of its conversation once', () => {
  const failed = submitted(begin(outgoing()), { error: '554 refused', passing: false }, iso(11));
  let all = observe(pressed, [failed], at(11), closesFor);
  all = press(all, { ...pressedWith(), pressedAt: at(30) });
  all = observe(all, [outgoing(iso(40))], at(30.2), closesFor);
  expect(leavingIn(all, thread, [parent, indexed])).toHaveLength(1);
});

test('a send gone without its copy stops waiting for it after a while', () => {
  let all = observe(pressed, [begin(outgoing())], at(10.5), closesFor);
  all = observe(all, [], at(12), closesFor);
  expect(nextExpiry(all)).toBe(at(12) + GONE_MS);
  expect(expire(all, at(12) + GONE_MS)).toBe(all);
  expect(expire(all, at(12) + GONE_MS + 1)).toEqual([]);
  expect(nextExpiry([])).toBeUndefined();
});

test('replies on their way lie soonest to go first, and a new message waits for its conversation', () => {
  const second = { ...draft, uid: 43 };
  const later = press(pressed, { ...pressedWith(), draft: second, at: iso(3600) });
  const sooner = press(later, { ...pressedWith(), draft: { ...draft, uid: 44 }, pressedAt: at(1) });
  expect(leavingIn(sooner, thread, [parent]).map(({ leaving }) => leaving.draft.uid)).toEqual([
    42, 44, 43,
  ]);
  const fresh = press([], { ...pressedWith(), pressedIn: undefined });
  expect(leavingIn(fresh, thread, [parent])).toEqual([]);
  const named = observe(fresh, [outgoing()], at(1), closesFor);
  expect(leavingIn(named, thread, [parent])).toHaveLength(1);
});

function pressedWith(): Parameters<typeof press>[1] {
  return { draft, pressedIn: thread, written: 'Thursday works.', pressedAt: at(0), at: undefined };
}

function message(
  fields: Partial<Message> & Pick<Message, 'uid' | 'path' | 'messageId'>,
  isDraft = false,
): Message {
  return {
    account: 'personal',
    uidValidity: 7,
    conversation: thread,
    date: iso(0),
    from: { email: 'me@example.com' },
    to: [],
    cc: [],
    subject: 'Lunch',
    preview: '',
    flags: { seen: true, flagged: false, answered: false, draft: isDraft },
    hasAttachments: false,
    verified: false,
    references: [],
    ...fields,
  };
}
