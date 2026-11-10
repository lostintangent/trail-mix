import { afterAll, beforeAll, expect, test } from 'bun:test';
import { aheadOf, laterTimes } from './later.ts';

// A zone with daylight saving, which moves a day's length off 24 hours twice a year.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  process.env.TZ = zone;
});

const local = (day: string, time: string) => new Date(`${day}T${time}:00`);
const offered = (now: Date) =>
  laterTimes(now).map(({ label, at }) => [label, at.toString().slice(0, 21)]);

test('Send later offers an hour from now, this evening, and tomorrow morning', () => {
  // Tuesday morning.
  expect(offered(local('2026-11-10', '09:12'))).toEqual([
    ['In an hour', 'Tue Nov 10 2026 10:12'],
    ['This evening', 'Tue Nov 10 2026 18:00'],
    ['Tomorrow morning', 'Wed Nov 11 2026 08:00'],
  ]);
});

test('this evening drops out once it is an hour off or less', () => {
  const labels = (time: string) => laterTimes(local('2026-11-10', time)).map(({ label }) => label);
  expect(labels('16:59')).toContain('This evening');
  expect(labels('17:00')).not.toContain('This evening');
  expect(labels('23:30')).toEqual(['In an hour', 'Tomorrow morning']);
});

test('Monday morning is offered on a Friday and a Saturday, when tomorrow isn’t Monday', () => {
  const monday = (day: string) =>
    laterTimes(local(day, '20:00')).find(({ label }) => label === 'Monday morning')?.at;
  expect(monday('2026-11-13')).toEqual(local('2026-11-16', '08:00'));
  expect(monday('2026-11-14')).toEqual(local('2026-11-16', '08:00'));
  expect(monday('2026-11-15')).toBeUndefined();
  expect(monday('2026-11-12')).toBeUndefined();
});

test('tomorrow morning is eight o’clock across a change of clocks', () => {
  // Clocks go back an hour early on Sunday the 1st, so that day is 25 hours long.
  expect(offered(local('2026-10-31', '22:00'))).toContainEqual([
    'Tomorrow morning',
    'Sun Nov 01 2026 08:00',
  ]);
  expect(offered(local('2026-11-01', '22:00'))).toContainEqual([
    'Tomorrow morning',
    'Mon Nov 02 2026 08:00',
  ]);
});

test('a time ahead reads as today, tomorrow, this week, then a date, by calendar day', () => {
  const now = local('2026-11-10', '23:00');
  expect(aheadOf(local('2026-11-10', '23:59'), now)).toBe('today');
  expect(aheadOf(local('2026-11-11', '00:01'), now)).toBe('tomorrow');
  expect(aheadOf(local('2026-11-16', '08:00'), now)).toBe('week');
  expect(aheadOf(local('2026-11-17', '08:00'), now)).toBe('later');
});
