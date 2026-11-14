import { expect, test } from 'bun:test';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import {
  awayFromDrafts,
  draftsStillCounted,
  isDraftsView,
  leavesDrafts,
  notePeaks,
  type Peak,
} from './drafts.ts';
import { forget, named, observe, press, type Leaving } from './leaving.ts';
import { begin, schedule, submitted } from './outbox.ts';
import { closesAt } from './standing.ts';

const T0 = Date.parse('2026-11-10T09:00:00.000Z');
/** The time `seconds` after nine. */
const at = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const thread = 'thread-lunch';
const draft = { account: 'personal', path: 'Drafts', uidValidity: 7, uid: 42 };
const second = { ...draft, uid: 43 };

const outgoing = (of: MessageRef = draft, id = 'one'): Outgoing => ({
  ...schedule(
    { id, draft: of, messageId: `<${id}@trailmix.invalid>`, to: [], subject: 'Lunch' },
    iso(0),
  ),
  conversation: thread,
});
/** A press of Send, of a draft, or of a message never saved, for `null`. */
const pressing = (of: MessageRef | null = draft, all: readonly Leaving[] = []) =>
  press(all, {
    id: `press ${of?.uid ?? 'unsaved'}`,
    draft: of ?? undefined,
    pressedIn: thread,
    written: 'Thursday works.',
    to: [],
    pressedAt: at(0),
    at: undefined,
  });
const accepted = (of?: MessageRef, id?: string) =>
  submitted(begin(outgoing(of, id)), 'sent', iso(11));
const refused = submitted(begin(outgoing()), { error: '554 refused', passing: false }, iso(11));

/**
 * A device's view of the Drafts count as the folders' snapshots arrive: what it has seen of each
 * send's folder, and how many drafts on their way that folder still holds.
 */
function counting() {
  let peaks: readonly Peak[] = [];
  return (all: readonly Leaving[], count: number) => {
    const countOf = (of: MessageRef) => (of.path === 'Drafts' ? count : undefined);
    peaks = notePeaks(peaks, all, countOf);
    return draftsStillCounted(all, peaks, countOf);
  };
}

test('the Drafts view leaves out a conversation whose drafts are all on their way, and only then', () => {
  const pressed = pressing();
  const other = { ...draft, uid: 50 };
  // Seen with the draft on its way alone, or not seen at all, as a new message's isn't.
  expect([...awayFromDrafts(pressed, () => [draft])]).toEqual([thread]);
  expect([...awayFromDrafts(pressed, () => undefined)]).toEqual([thread]);
  // A second draft there still waits, so the conversation stays.
  expect([...awayFromDrafts(pressed, () => [draft, other])]).toEqual([]);
  // One asked for elsewhere is left out of the conversation the Outbox names.
  expect([...awayFromDrafts(observe([], [outgoing()], at(1), closesAt), () => [draft])]).toEqual([
    thread,
  ]);
  // A send that failed is a draft again.
  expect([...awayFromDrafts(observe(pressed, [refused], at(11), closesAt), () => [draft])]).toEqual(
    [],
  );
});

test('the count holds a draft on its way from the press until it falls after the send has gone', () => {
  const count = counting();
  let all = pressing();
  expect(count(all, 3)).toBe(1);
  all = observe(all, [outgoing()], at(1), closesAt);
  expect(count(all, 3)).toBe(1);
  all = observe(all, [accepted()], at(11), closesAt);
  expect(count(all, 3)).toBe(1);
  // Gone from the Outbox, it is still in the count until the listing after Drafts syncs.
  all = observe(all, [], at(12), closesAt);
  expect(count(all, 3)).toBe(1);
  expect(count(all, 2)).toBe(0);
});

test('a count that fell before the Outbox let its send go holds the draft no longer', () => {
  const count = counting();
  let all = observe(pressing(), [accepted()], at(11), closesAt);
  expect(count(all, 3)).toBe(1);
  // The folders' snapshot after Drafts synced came first. The Outbox's says the send went.
  count(all, 2);
  all = observe(all, [], at(12), closesAt);
  expect(count(all, 2)).toBe(0);
});

test('a draft saved as Send is pressed is held once the count has it, and until it falls', () => {
  const count = counting();
  // The count from before the draft was saved.
  let all = pressing();
  count(all, 2);
  all = observe(all, [outgoing()], at(1), closesAt);
  expect(count(all, 3)).toBe(1);
  all = observe(all, [], at(12), closesAt);
  expect(count(all, 3)).toBe(1);
  expect(count(all, 2)).toBe(0);
});

test('two sends from one Drafts folder leave its count one at a time', () => {
  const count = counting();
  let all = pressing(second, pressing());
  all = observe(all, [accepted(), accepted(second, 'two')], at(11), closesAt);
  expect(count(all, 5)).toBe(2);
  all = observe(all, [accepted(second, 'two')], at(12), closesAt);
  expect(count(all, 5)).toBe(2);
  expect(count(all, 4)).toBe(1);
  all = observe(all, [], at(13), closesAt);
  expect(count(all, 4)).toBe(1);
  expect(count(all, 3)).toBe(0);
});

test('a send that failed or was undone is a draft in the count again, and one sent again starts over', () => {
  const count = counting();
  expect(count(observe(pressing(), [refused], at(11), closesAt), 3)).toBe(0);
  let all = pressing();
  expect(count(all, 4)).toBe(1);
  all = forget(all, 'press 42');
  expect(count(all, 3)).toBe(0);
  // Sent again at the count it fell to, it is held until the count falls from there.
  all = observe(pressing(draft, all), [outgoing()], at(12), closesAt);
  expect(count(all, 3)).toBe(1);
  all = observe(all, [], at(20), closesAt);
  expect(count(all, 3)).toBe(1);
  expect(count(all, 2)).toBe(0);
});

test('a message saved again on its way keeps each draft out of Drafts, and is counted once', () => {
  const count = counting();
  let all = named(pressing(), 'press 42', second);
  expect([...awayFromDrafts(all, () => [draft, second])]).toEqual([thread]);
  expect([...awayFromDrafts(all, () => [second])]).toEqual([thread]);
  expect(leavesDrafts(all, [draft])).toBe(true);
  expect(count(all, 3)).toBe(1);
  all = observe(observe(all, [outgoing(second)], at(1), closesAt), [], at(12), closesAt);
  expect(count(all, 3)).toBe(1);
  expect(count(all, 2)).toBe(0);
});

test('a message pressed before it was ever saved is counted from the save that names its draft', () => {
  const count = counting();
  let all = pressing(null);
  expect([...awayFromDrafts(all, () => undefined)]).toEqual([thread]);
  expect(count(all, 2)).toBe(0);
  all = named(all, 'press unsaved', draft);
  expect(count(all, 3)).toBe(1);
  all = observe(observe(all, [outgoing()], at(1), closesAt), [], at(12), closesAt);
  expect(count(all, 3)).toBe(1);
  expect(count(all, 2)).toBe(0);
});

test('a draft outside a Drafts folder the device knows is no part of the count', () => {
  const elsewhere = { ...draft, path: 'Old Drafts' };
  expect(counting()(pressing(elsewhere), 3)).toBe(0);
});

test('a Drafts view is the unified one, or a folder whose role is drafts', () => {
  const folders = [
    { account: 'personal', path: 'Drafts', name: 'Drafts', role: 'drafts', unread: 0, total: 3 },
    { account: 'personal', path: 'INBOX', name: 'Inbox', role: 'inbox', unread: 0, total: 9 },
  ] as const;
  expect(isDraftsView({ in: 'drafts' }, folders)).toBe(true);
  expect(
    isDraftsView({ in: 'folder', folder: { account: 'personal', path: 'Drafts' } }, folders),
  ).toBe(true);
  expect(
    isDraftsView({ in: 'folder', folder: { account: 'personal', path: 'INBOX' } }, folders),
  ).toBe(false);
  expect(isDraftsView({ in: 'inbox' }, folders)).toBe(false);
});

test('a send leaves its conversation out of Drafts only once its other drafts are on their way', () => {
  const pressed = pressing();
  expect(leavesDrafts(pressed, [])).toBe(true);
  expect(leavesDrafts(pressed, [second])).toBe(false);
  expect(leavesDrafts(pressing(second, pressed), [second])).toBe(true);
  // One whose send failed is a draft again.
  expect(leavesDrafts(observe(pressing(second), [refused], at(11), closesAt), [draft])).toBe(false);
});
