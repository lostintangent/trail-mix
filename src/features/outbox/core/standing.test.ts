import { expect, test } from 'bun:test';
import type { Outgoing } from '../../mail/core/index.ts';
import { begin, schedule, submitted } from './outbox.ts';
import {
  briefly,
  closesAfterPress,
  closesAt,
  follow,
  followed,
  fully,
  isLeaving,
  isOnItsWay,
  isUndoable,
  standingOf,
  standingOfFollowed,
  standingOfPress,
  standingOfWait,
} from './standing.ts';

const T0 = Date.parse('2026-11-10T09:00:00.000Z');
/** The time `seconds` after nine. */
const at = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const mina = { name: 'Mina Okafor', email: 'mina@example.com' };
const entry = {
  id: 'one',
  draft: { account: 'personal', path: 'Drafts', uidValidity: 7, uid: 42 },
  messageId: '<one@trailmix.invalid>',
  to: [mina],
  subject: 'Lunch',
};
/** A send pressed at nine on this device, which the Mailroom, its clock 0.5s ahead, scheduled. */
const pressed = schedule(entry, iso(0.5));
const closes = closesAfterPress(at(0));
const refused = { error: '554 5.4.4 unreachable.example can’t be reached', passing: false };

test('a send counts down the undo window in whole seconds, then is sending', () => {
  expect(standingOf(pressed, closes, at(0.3))).toEqual({ is: 'counting', seconds: 10 });
  expect(standingOf(pressed, closes, at(2.1))).toEqual({ is: 'counting', seconds: 8 });
  expect(standingOf(pressed, closes, at(9.9))).toEqual({ is: 'counting', seconds: 1 });
  expect(standingOf(pressed, closes, at(10))).toEqual({ is: 'sending' });
  expect(standingOf(begin(pressed), closes, at(10.2))).toEqual({ is: 'sending' });
  expect(standingOf(submitted(begin(pressed), 'sent', iso(11)), closes, at(11))).toEqual({
    is: 'sent',
  });
});

test('Undo ends when the window can first close on this clock, before the Mailroom’s', () => {
  // The Mailroom's window closes at 10.5 on this clock. Undo ends at 10.
  expect(isUndoable(standingOf(pressed, closes, at(9.99)))).toBe(true);
  expect(isUndoable(standingOf(pressed, closes, at(10)))).toBe(false);
});

test('a send scheduled ahead shows its time, then counts down its last ten seconds', () => {
  const later = schedule(entry, iso(0), iso(3600));
  expect(standingOf(later, closesAt(later), at(0))).toEqual({ is: 'scheduled', at: iso(3600) });
  expect(isUndoable(standingOf(later, closesAt(later), at(0)))).toBe(true);
  expect(standingOf(later, closesAt(later), at(3592))).toEqual({ is: 'counting', seconds: 8 });
  expect(standingOf(later, closesAt(later), at(3600))).toEqual({ is: 'sending' });
});

test('a failure shows the server’s reason, and whether it will try again on its own', () => {
  const offline = { error: 'Couldn’t reach smtp.example.com', passing: true };
  const retrying = submitted(begin(pressed), offline, iso(10.5));
  expect(standingOf(retrying, closes, at(20))).toEqual({
    is: 'retrying',
    error: offline.error,
    at: retrying.sendAt,
  });
  // Seen while this device's countdown is a moment short of the window's close, it still retries.
  expect(standingOf(retrying, closes, at(9.9)).is).toBe('retrying');
  const failed: Outgoing = submitted(begin(pressed), refused, iso(10.5));
  expect(standingOf(failed, closes, at(20))).toEqual({ is: 'failed', error: refused.error });
  expect(isUndoable(standingOf(failed, closes, at(20)))).toBe(false);
});

test('a press the Mailroom can’t be reached for says why, and offers Undo while its window is open', () => {
  const waiting = standingOfWait(new Date(closes).toISOString(), closes, at(8));
  expect(standingOfPress(waiting, undefined)).toEqual({ is: 'counting', seconds: 2 });
  const unreached = standingOfPress(waiting, 'This device is offline.');
  expect(unreached).toEqual({ is: 'unreached', error: 'This device is offline.', isWaiting: true });
  expect(isUndoable(unreached)).toBe(true);
  // Airmail stays, and stands still, since nothing is on its way.
  expect(isLeaving(unreached)).toBe(true);
  expect(isOnItsWay(unreached)).toBe(false);

  const closed = standingOfPress(
    standingOfWait(new Date(closes).toISOString(), closes, at(12)),
    'No answer came: Load failed',
  );
  expect(closed).toEqual({
    is: 'unreached',
    error: 'No answer came: Load failed.',
    isWaiting: false,
  });
  expect(isUndoable(closed)).toBe(false);
});

test('a followed send seen begun and then gone has gone', () => {
  let seen = follow(followed(pressed), pressed, at(1));
  seen = follow(seen, begin(pressed), at(10.6));
  seen = follow(seen, undefined, at(11));
  expect(standingOfFollowed(seen, closes, at(11), false)).toEqual({ is: 'sent' });
});

test('a followed send seen gone before its window closed was undone, whenever it is asked', () => {
  const seen = follow(followed(pressed), undefined, at(4));
  expect(standingOfFollowed(seen, closes, at(4), false)).toEqual({ is: 'undone' });
  expect(standingOfFollowed(seen, closes, at(60), false)).toEqual({ is: 'undone' });
});

test('a send that failed after it began, and was then given up, is never claimed sent', () => {
  const failed = submitted(begin(pressed), refused, iso(10.5));
  let seen = follow(followed(pressed), begin(pressed), at(10.6));
  seen = follow(seen, failed, at(11));
  seen = follow(seen, undefined, at(30));
  expect(standingOfFollowed(seen, closes, at(30), false)).toEqual({ is: 'undone' });
});

test('a send retrying after it began, then gone, is sending until Sent holds its copy', () => {
  // Undone in its wait, or begun again and gone between snapshots: only its copy can say.
  const offline = { error: 'Couldn’t reach smtp.example.com', passing: true };
  let seen = follow(followed(pressed), begin(pressed), at(10.6));
  seen = follow(seen, submitted(begin(pressed), offline, iso(11)), at(11));
  seen = follow(seen, undefined, at(30));
  expect(standingOfFollowed(seen, closes, at(30), false)).toEqual({ is: 'sending' });
  expect(standingOfFollowed(seen, closes, at(31), true)).toEqual({ is: 'sent' });
});

test('a followed send seen gone only after its time is sending until Sent holds its copy', () => {
  // A snapshot can arrive late, after an undo elsewhere, so absence alone never says it went.
  const seen = follow(followed(pressed), undefined, at(12));
  expect(seen.goneAt).toBe(at(12));
  expect(follow(seen, undefined, at(14)).goneAt).toBe(at(12));
  expect(standingOfFollowed(seen, closes, at(12), false)).toEqual({ is: 'sending' });
  expect(standingOfFollowed(seen, closes, at(13), true)).toEqual({ is: 'sent' });
});

test('a followed send that comes back, as a failed one sent again does, is followed afresh', () => {
  const failed = submitted(begin(pressed), refused, iso(10.5));
  const seen = follow(follow(followed(pressed), undefined, at(4)), failed, at(20));
  expect(standingOfFollowed(seen, closes, at(20), false)).toEqual({
    is: 'failed',
    error: refused.error,
  });
});

test('airmail marks what is leaving, and not what failed or was undone', () => {
  const failed = submitted(begin(pressed), refused, iso(10.5));
  expect(isLeaving(standingOf(pressed, closes, at(1)))).toBe(true);
  expect(isLeaving(standingOf(begin(pressed), closes, at(11)))).toBe(true);
  expect(isLeaving({ is: 'sent' })).toBe(true);
  expect(isLeaving(standingOf(failed, closes, at(11)))).toBe(false);
  expect(isLeaving({ is: 'undone' })).toBe(false);
});

test('airmail runs while a send is on its way, and stands still before and after', () => {
  const failed = submitted(begin(pressed), refused, iso(10.5));
  expect(isOnItsWay(standingOf(pressed, closes, at(1)))).toBe(true);
  expect(isOnItsWay(standingOf(pressed, closes, at(11)))).toBe(true);
  expect(isOnItsWay(standingOf(begin(pressed), closes, at(11)))).toBe(true);
  expect(isOnItsWay({ is: 'scheduled', at: iso(3600) })).toBe(false);
  expect(isOnItsWay(standingOf(failed, closes, at(11)))).toBe(false);
  expect(isOnItsWay({ is: 'retrying', error: refused.error ?? '', at: iso(60) })).toBe(false);
  expect(isOnItsWay({ is: 'sent' })).toBe(false);
});

test('a toast names recipients by first name, and a row names them in full', () => {
  const ada = { name: 'Ada Park', email: 'ada@example.com' };
  const desk = { email: 'bookings@unreachable.example' };
  expect(briefly([mina])).toBe('Mina');
  expect(briefly([desk])).toBe('bookings@unreachable.example');
  expect(briefly([mina, ada])).toBe('Mina and Ada');
  expect(briefly([mina, ada, desk])).toBe('Mina and 2 others');
  expect(briefly([])).toBe('undisclosed recipients');
  expect(fully([mina, desk])).toBe('Mina Okafor, bookings@unreachable.example');
  expect(fully([])).toBe('Undisclosed recipients');
});
