import { describe, expect, test } from 'bun:test';
import { EXPIRED } from '../../providers/imap/core/index.ts';
import {
  KEEP_REASON_MS,
  RESTARTED_SIGN_IN,
  due,
  expired,
  kept,
  nextWake,
  polled,
  recover,
  refused,
  started,
  type Pending,
} from './sign-in.ts';

const NOW = Date.parse('2026-11-10T20:00:00Z');
const code = {
  code: 'F7KQ2M9XR',
  link: 'https://www.microsoft.com/link',
  expiresAt: NOW + 900_000,
  interval: 5000,
};
const outlook = { preset: 'outlook', name: 'Outlook' } as const;
const start = () => started('me@outlook.com', outlook, code, NOW);
const TOKENS = { access: 'a', refresh: 'r', expiresAt: NOW + 3_600_000 };

describe('a waiting sign-in', () => {
  test('is polled once each interval has passed, and not before', () => {
    const pending = start();
    expect(due(pending, NOW + 4999)).toBeUndefined();
    expect(due(pending, NOW + 5000)).toBe('poll');
    const again = polled(pending, { pending: 5000 }, NOW + 5000);
    expect(due(again, NOW + 9999)).toBeUndefined();
    expect(due(again, NOW + 10_000)).toBe('poll');
  });

  test('polls further apart once told to slow down', () => {
    const slowed = polled(start(), { pending: 10_000 }, NOW + 5000);
    expect(slowed).toMatchObject({ state: 'waiting', interval: 10_000, pollAt: NOW + 15_000 });
  });

  test('stops at its code’s expiry without asking the vendor', () => {
    const pending = { ...start(), pollAt: NOW + 900_000 + 5000 };
    expect(due(pending, NOW + 900_000)).toBe('expire');
    expect(expired(pending, NOW + 900_000)).toMatchObject({ state: 'refused', reason: EXPIRED });
  });

  test('is checked once approved, and stops with the vendor’s reason when refused', () => {
    expect(polled(start(), { granted: TOKENS }, NOW + 5000)).toMatchObject({ state: 'checking' });
    expect(due(polled(start(), { granted: TOKENS }, NOW + 5000), NOW + 60_000)).toBeUndefined();
    expect(
      polled(start(), { refused: 'You declined the sign-in at Microsoft.' }, NOW + 5000),
    ).toEqual({
      ...start(),
      state: 'refused',
      reason: 'You declined the sign-in at Microsoft.',
      stoppedAt: NOW + 5000,
    });
  });
});

describe('a stopped sign-in', () => {
  test('keeps its reason until its code would have expired', () => {
    const stopped = refused(start(), 'outlook.office365.com refused the sign-in.', NOW + 60_000);
    expect(kept(stopped, NOW + 900_000 - 1)).toBe(true);
    expect(kept(stopped, NOW + 900_000)).toBe(false);
  });

  test('keeps its reason five minutes, when it stops near its code’s expiry', () => {
    const late = NOW + 899_000;
    const stopped = refused(start(), 'outlook.office365.com refused the sign-in.', late);
    expect(kept(stopped, late + KEEP_REASON_MS - 1)).toBe(true);
    expect(kept(stopped, late + KEEP_REASON_MS)).toBe(false);
  });

  test('is never polled again', () => {
    const stopped = refused(start(), 'No.', NOW);
    expect(due(stopped, NOW + 60_000)).toBeUndefined();
    expect(nextWake([stopped])).toBeUndefined();
  });
});

test('one being checked when the Mailroom restarted stops, since its tokens went with it', () => {
  const checking = polled(start(), { granted: TOKENS }, NOW + 5000);
  expect(recover(checking, NOW + 6000)).toMatchObject({
    state: 'refused',
    reason: RESTARTED_SIGN_IN,
  });
  const waiting = start();
  expect(recover(waiting, NOW + 6000)).toBe(waiting);
});

test('the next wake is the soonest waiting poll, or expiry when that comes first', () => {
  const soon = start();
  const later: Pending = {
    ...started('other@outlook.com', { account: 'a1' }, code, NOW),
    pollAt: NOW + 20_000,
  };
  const expiring: Pending = { ...start(), expiresAt: NOW + 2000 };
  const checking = polled(start(), { granted: TOKENS }, NOW);
  expect(nextWake([later, soon, checking])).toBe(NOW + 5000);
  expect(nextWake([later, expiring])).toBe(NOW + 2000);
  expect(nextWake([checking])).toBeUndefined();
  expect(nextWake([])).toBeUndefined();
});
