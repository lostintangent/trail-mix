import { expect, test } from 'bun:test';
import { erasesAt, idlenessOf, isWorthNoting, MEMBER_WIND_DOWN, windDownOf } from './idle.ts';

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
