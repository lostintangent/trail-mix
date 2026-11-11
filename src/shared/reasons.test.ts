import { expect, test } from 'bun:test';
import { reasonOf } from './reasons.ts';

test('a refusal says the server’s reason, as a sentence', () => {
  expect(reasonOf(new Error('The folder is gone'))).toBe('The folder is gone.');
  expect(reasonOf(new Error('Too many changes.'))).toBe('Too many changes.');
  expect(reasonOf(new Error(''))).toBe('The mail server gave no reason.');
});

test('a fetch that got no answer says the device is offline, or that the server wasn’t reached', () => {
  for (const said of [
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    'Load failed',
  ]) {
    expect(reasonOf(new TypeError(said), false)).toBe('This device is offline.');
    expect(reasonOf(new TypeError(said), true)).toBe('Trail Mix couldn’t reach its server.');
  }
  // Only the browser's own failure: a server's reason that happens to read so is still its own.
  expect(reasonOf(new Error('Failed to fetch'), false)).toBe('Failed to fetch.');
});
