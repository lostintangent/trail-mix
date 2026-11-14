import { describe, expect, test } from 'bun:test';
import {
  erasesAt,
  idlenessOf,
  isWorthNoting,
  MEMBER_WIND_DOWN,
  scheduleOf,
  windDownOf,
  type Waking,
} from './idle.ts';

const opened = Date.UTC(2026, 10, 10);
const DAY = 24 * 60 * 60_000;

test('a member’s Mailroom stays open for 30 days after it was last opened, and rests from the 30th', () => {
  expect(idlenessOf(opened, opened, MEMBER_WIND_DOWN)).toBe('open');
  expect(idlenessOf(opened, opened + 30 * DAY - 1, MEMBER_WIND_DOWN)).toBe('open');
  expect(idlenessOf(opened, opened + 30 * DAY, MEMBER_WIND_DOWN)).toBe('resting');
});

test('a resting Mailroom erases itself from the 90th day, and wakes for that alone', () => {
  expect(idlenessOf(opened, opened + 90 * DAY - 1, MEMBER_WIND_DOWN)).toBe('resting');
  expect(idlenessOf(opened, opened + 90 * DAY, MEMBER_WIND_DOWN)).toBe('erasing');
  expect(idlenessOf(opened, opened + 400 * DAY, MEMBER_WIND_DOWN)).toBe('erasing');
  expect(erasesAt(opened, MEMBER_WIND_DOWN)).toBe(opened + 90 * DAY);
});

test('a deployment sets its own wind-down in days, as the demo’s one-day erase does', () => {
  expect(windDownOf()).toEqual(MEMBER_WIND_DOWN);
  expect(windDownOf('', '')).toEqual(MEMBER_WIND_DOWN);
  const demo = windDownOf('1', '1');
  expect(demo).toEqual({ restsAfterMs: DAY, erasesAfterMs: DAY });
  expect(idlenessOf(opened, opened + DAY - 1, demo)).toBe('open');
  expect(idlenessOf(opened, opened + DAY, demo)).toBe('erasing');
  expect(windDownOf(undefined, '120')).toEqual({
    restsAfterMs: 30 * DAY,
    erasesAfterMs: 120 * DAY,
  });
});

test('a wind-down that isn’t whole days, or rests after it erases, is refused as the Mailroom starts', () => {
  expect(() => windDownOf('0')).toThrow(/REST_AFTER_DAYS must be a whole number of days/);
  expect(() => windDownOf(undefined, '1.5')).toThrow(/ERASE_AFTER_DAYS must be a whole number/);
  expect(() => windDownOf('a month')).toThrow(/REST_AFTER_DAYS/);
  expect(() => windDownOf('100')).toThrow(/no more than ERASE_AFTER_DAYS/);
});

test('an opening is written down at most once an hour', () => {
  expect(isWorthNoting(opened, opened)).toBe(false);
  expect(isWorthNoting(opened, opened + 60 * 60_000 - 1)).toBe(false);
  expect(isWorthNoting(opened, opened + 60 * 60_000)).toBe(true);
});

describe('the wake schedule', () => {
  const now = opened + DAY;
  const MINUTE = 60_000;
  /** A member's Mailroom, closed, last checked five minutes ago. */
  const waking = (change: Partial<Waking> = {}): Waking => ({
    now,
    isWatched: false,
    isNotifying: false,
    isVisitors: false,
    checkedAt: now - 5 * MINUTE,
    openedAt: opened,
    ...change,
  });
  const scheduled = (change: Partial<Waking> = {}) => scheduleOf(waking(change), MEMBER_WIND_DOWN);

  test('while a device is open, the alarm comes every minute, and each account is checked every five', () => {
    expect(scheduled({ isWatched: true })).toEqual({ pollAt: now + MINUTE, isCheckDue: true });
    expect(scheduled({ isWatched: true, checkedAt: now - MINUTE })).toEqual({
      pollAt: now + MINUTE,
      isCheckDue: false,
    });
  });

  test('with no device open, a member’s Mailroom checks every five minutes, or every four while one is notified', () => {
    expect(scheduled()).toEqual({ pollAt: now + 5 * MINUTE, isCheckDue: true });
    expect(scheduled({ checkedAt: now - 4 * MINUTE }).isCheckDue).toBe(false);
    expect(scheduled({ isNotifying: true, checkedAt: now - 4 * MINUTE })).toEqual({
      pollAt: now + 4 * MINUTE,
      isCheckDue: true,
    });
  });

  test('a check is due up to a second early, since an alarm may come by another machine’s clock', () => {
    expect(scheduled({ checkedAt: now - 5 * MINUTE + 1000 }).isCheckDue).toBe(true);
    expect(scheduled({ checkedAt: now - 5 * MINUTE + 1001 }).isCheckDue).toBe(false);
  });

  test('a visitor’s Mailroom checks as it first fills and while it is open, and otherwise sleeps until its erase', () => {
    const demo = windDownOf('1', '1');
    const visited = now - 60 * MINUTE;
    const visitor = (change: Partial<Waking>) =>
      scheduleOf(waking({ isVisitors: true, openedAt: visited, ...change }), demo);
    expect(visitor({ checkedAt: 0 })).toEqual({ pollAt: now + 5 * MINUTE, isCheckDue: true });
    expect(visitor({ isWatched: true })).toEqual({ pollAt: now + MINUTE, isCheckDue: true });
    expect(visitor({ checkedAt: now - 60 * MINUTE })).toEqual({
      pollAt: visited + DAY,
      isCheckDue: false,
    });
  });
});
