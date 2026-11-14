import { expect, test } from 'bun:test';
import { triageAt } from './triagePlaces.ts';

test('a desktop shows every triage control in its bar, and nowhere else', () => {
  expect(triageAt('bar', false)).toBe('all');
  expect(triageAt('top', false)).toBeUndefined();
  expect(triageAt('island', false)).toBeUndefined();
});

test('a phone marks at the top and files in the island, and shows no bar', () => {
  expect(triageAt('top', true)).toBe('marking');
  expect(triageAt('island', true)).toBe('filing');
  expect(triageAt('bar', true)).toBeUndefined();
});
