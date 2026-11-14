import { expect, test } from 'bun:test';
import type { Message, Outgoing } from '../../mail/core/index.ts';
import {
  draftOf,
  draftsLeaving,
  expire,
  forget,
  GONE_MS,
  isAway,
  leavingIn,
  named,
  nextExpiry,
  observe,
  press,
  standingOfLeaving,
  toastFor,
} from './leaving.ts';
import { begin, filed, schedule, submitted } from './outbox.ts';
import { closesAt, followed } from './standing.ts';

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
  ...pressedWith(),
  written: 'Thursday works.\n\n> On Monday, Mina wrote:\n> Lunch?\nSee you there.',
});

test('a reply pressed is on its way at once, at the end of its conversation, as it was written', () => {
  expect(leavingIn(pressed, thread, [parent])).toEqual([
    { leaving: pressed[0]!, preview: 'Thursday works. See you there.' },
  ]);
  expect(standingOfLeaving(pressed[0]!, at(1))).toEqual({ is: 'counting', seconds: 9 });
  expect(draftsLeaving(pressed)).toEqual([draft]);
  expect(leavingIn(pressed, 'another-thread', [parent])).toEqual([]);
});

test('a reply pressed for later waits for its time', () => {
  const later = press([], { ...pressedWith(), at: iso(3600) });
  expect(standingOfLeaving(later[0]!, at(1))).toEqual({ is: 'scheduled', at: iso(3600) });
});

test('a press the Mailroom refused is forgotten, and its draft is a draft again', () => {
  const refused = forget(pressed, 'press');
  expect(leavingIn(refused, thread, [parent, indexed])).toEqual([]);
  expect(draftsLeaving(refused)).toEqual([]);
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
  expect(draftsLeaving(all)).toEqual([draft]);
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
  expect(draftsLeaving(all)).toEqual([]);
});

test('a failed send stays at the end of its conversation saying why, back in Drafts, until given up', () => {
  const refused = { error: '554 refused', passing: false };
  const failed = submitted(begin(outgoing()), refused, iso(11));
  let all = observe(pressed, [failed], at(11), closesFor);
  expect(leavingIn(all, thread, [parent, indexed])).toEqual([
    { leaving: all[0]!, preview: 'Thursday works. See you there.' },
  ]);
  expect(standingOfLeaving(all[0]!, at(11))).toEqual({ is: 'failed', error: '554 refused' });
  expect(draftsLeaving(all)).toEqual([draft]);
  expect(isAway(all[0]!)).toBe(false);
  all = observe(all, [], at(20), closesFor);
  expect(all).toEqual([]);
});

test('a draft sent again after its send failed lies at the end of its conversation once', () => {
  const failed = submitted(begin(outgoing()), { error: '554 refused', passing: false }, iso(11));
  let all = observe(pressed, [failed], at(11), closesFor);
  all = press(all, { ...pressedWith(), id: 'again', pressedAt: at(30) });
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
  const later = press(pressed, { ...pressedWith(), id: 'later', draft: second, at: iso(3600) });
  const sooner = press(later, {
    ...pressedWith(),
    id: 'sooner',
    draft: { ...draft, uid: 44 },
    pressedAt: at(1),
  });
  expect(leavingIn(sooner, thread, [parent]).map(({ leaving }) => draftOf(leaving)?.uid)).toEqual([
    42, 44, 43,
  ]);
  const fresh = press([], { ...pressedWith(), pressedIn: undefined });
  expect(leavingIn(fresh, thread, [parent])).toEqual([]);
  const named = observe(fresh, [outgoing()], at(1), closesFor);
  expect(leavingIn(named, thread, [parent])).toHaveLength(1);
});

test('a reply’s toast is put away on its conversation, which says it all, and shows elsewhere', () => {
  const counting = pressed[0]!;
  expect(toastFor(counting, thread, true, at(1))).toBe('put away');
  expect(toastFor(counting, thread, false, at(1))).toBe('put away');
  expect(toastFor(counting, 'another-thread', false, at(1))).toBe('show');
  expect(toastFor(counting, undefined, false, at(1))).toBe('show');
  const sending = observe(pressed, [begin(outgoing())], at(10.5), closesFor)[0]!;
  expect(toastFor(sending, undefined, false, at(10.5))).toBe('show');
});

test('leaving a send’s conversation once it has stopped moving brings no toast', () => {
  const accepted = submitted(begin(outgoing()), 'sent', iso(11));
  const sent = observe(pressed, [accepted], at(11), closesFor)[0]!;
  expect(toastFor(sent, undefined, false, at(11))).toBe('stay');
  const failed = submitted(begin(outgoing()), { error: '554 refused', passing: false }, iso(11));
  expect(
    toastFor(observe(pressed, [failed], at(11), closesFor)[0]!, undefined, false, at(11)),
  ).toBe('stay');
  const later = press([], { ...pressedWith(), at: iso(3600) })[0]!;
  expect(toastFor(later, undefined, false, at(1))).toBe('stay');
});

test('a send first seen away from its conversation shows its toast, as a new message’s does', () => {
  const fresh = observe(
    press([], { ...pressedWith(), pressedIn: undefined }),
    [outgoing()],
    at(1),
    closesFor,
  );
  expect(toastFor(fresh[0]!, 'another-thread', true, at(1))).toBe('show');
  const later = press([], { ...pressedWith(), at: iso(3600) })[0]!;
  expect(toastFor(later, 'another-thread', true, at(1))).toBe('show');
});

test('a message pressed before it was ever saved is on its way, and its draft joins it once saved', () => {
  const unsaved = press([], { ...pressedWith(), draft: undefined });
  expect(leavingIn(unsaved, thread, [parent])).toEqual([
    { leaving: unsaved[0]!, preview: 'Thursday works.' },
  ]);
  expect(standingOfLeaving(unsaved[0]!, at(1))).toEqual({ is: 'counting', seconds: 9 });
  expect(draftsLeaving(unsaved)).toEqual([]);
  expect(observe(unsaved, [outgoing()], at(0.5), closesFor)[0]).not.toHaveProperty('seen');

  const saved = named(unsaved, 'press', draft);
  expect(draftsLeaving(saved)).toEqual([draft]);
  expect(observe(saved, [outgoing()], at(1), closesFor)).toEqual([
    { ...saved[0]!, seen: followed(outgoing()) },
  ]);
});

test('a message saved again on its way keeps both drafts out, and is the send of the last', () => {
  const resaved = { ...draft, uid: 43 };
  const all = named(named(pressed, 'press', resaved), 'press', resaved);
  expect(draftsLeaving(all)).toEqual([draft, resaved]);
  expect(leavingIn(all, thread, [parent, indexed])).toHaveLength(1);
  // A send that failed with the draft it replaced is another send, which this press doesn't take.
  const old = submitted(begin(outgoing()), { error: '554 refused', passing: false }, iso(11));
  const seen = observe(all, [old], at(11), closesFor);
  expect(seen[0]).toEqual(all[0]);
  expect(seen[1]).toMatchObject({ id: 'one', drafts: [draft], seen: followed(old) });
  const sent = { ...outgoing(), id: 'two', draft: resaved };
  expect(observe(all, [sent], at(1), closesFor)).toEqual([{ ...all[0]!, seen: followed(sent) }]);
});

test('a send the Outbox shows before its press hears what the last save made is the press’s', () => {
  // Send carried the last save, so the Outbox can name the draft before the Mailroom answers.
  const unsaved = press([], { ...pressedWith(), draft: undefined });
  const first = { ...outgoing(), id: 'press' };
  expect(observe(unsaved, [first], at(0.5), closesFor)).toEqual([
    { ...unsaved[0]!, drafts: [draft], seen: followed(first) },
  ]);
  const resaved = { ...draft, uid: 43 };
  const again = { ...outgoing(), id: 'press', draft: resaved };
  expect(observe(pressed, [again], at(0.5), closesFor)).toEqual([
    { ...pressed[0]!, drafts: [draft, resaved], seen: followed(again) },
  ]);
});

function pressedWith(): Parameters<typeof press>[1] {
  return {
    id: 'press',
    draft,
    pressedIn: thread,
    written: 'Thursday works.',
    to: [{ name: 'Mina Okafor', email: 'mina@example.com' }],
    pressedAt: at(0),
    at: undefined,
  };
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
