import { expect, test } from 'bun:test';
import { archives, driftOf } from './gestures.ts';

test('a finger that stays within ten pixels still holds the row', () => {
  expect(driftOf(0, 0)).toBe('holding');
  expect(driftOf(-6, 8)).toBe('holding');
  expect(driftOf(-6, 9)).toBe('elsewhere');
});

test('a finger past the slop swipes only when it goes left more than up or down', () => {
  expect(driftOf(-11, 0)).toBe('swiping');
  expect(driftOf(-12, 11)).toBe('swiping');
  expect(driftOf(-12, -11)).toBe('swiping');
  expect(driftOf(-12, 12)).toBe('elsewhere');
  expect(driftOf(3, 20)).toBe('elsewhere');
});

test('a finger that goes right never swipes', () => {
  expect(driftOf(40, 0)).toBe('elsewhere');
});

test('a swipe archives once let go past four tenths of the row, leftward', () => {
  expect(archives(-161, 400)).toBe(true);
  expect(archives(-160, 400)).toBe(false);
  expect(archives(200, 400)).toBe(false);
});
