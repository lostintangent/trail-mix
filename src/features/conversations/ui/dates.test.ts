import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dateDistance } from './dates.ts';

// A zone with daylight saving, which moves a day's length off 24 hours twice a year.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  process.env.TZ = zone;
});

const at = (day: string, time = '12:00') => new Date(`${day}T${time}:00`);

test('a date reads as today, yesterday, the last week, this year, then before', () => {
  const now = at('2026-11-10', '09:00');

  expect(dateDistance(at('2026-11-10', '00:05'), now)).toBe('today');
  expect(dateDistance(at('2026-11-09', '20:00'), now)).toBe('yesterday');
  expect(dateDistance(at('2026-11-04'), now)).toBe('week');
  expect(dateDistance(at('2026-11-03'), now)).toBe('year');
  expect(dateDistance(at('2026-01-01'), now)).toBe('year');
  expect(dateDistance(at('2025-12-31'), now)).toBe('older');
});

test('days turn over at midnight, not 24 hours later', () => {
  expect(dateDistance(at('2026-11-09', '23:00'), at('2026-11-10', '01:00'))).toBe('yesterday');
  expect(dateDistance(at('2026-11-10', '01:00'), at('2026-11-10', '23:00'))).toBe('today');
});

test('a day shortened or lengthened by daylight saving is still one day', () => {
  expect(dateDistance(at('2026-03-08', '00:30'), at('2026-03-09', '00:30'))).toBe('yesterday');
  expect(dateDistance(at('2026-10-31', '23:30'), at('2026-11-01', '23:30'))).toBe('yesterday');
});

test('a date from a clock running ahead reads as a date, not a time today', () => {
  const now = at('2026-11-10');

  expect(dateDistance(at('2026-11-11'), now)).toBe('year');
  expect(dateDistance(at('2031-01-01'), now)).toBe('older');
});
