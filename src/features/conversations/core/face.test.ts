import { expect, test } from 'bun:test';
import { faceOf } from './face.ts';

const selves = new Set(['me@example.com', 'me@work.example.com']);

test('a row shows its newest sender who isn’t the member, by any of their addresses', () => {
  const senders = [
    { email: 'Me@Work.example.com' },
    { email: 'me@example.com' },
    { email: 'ada@example.com' },
    { email: 'bo@example.com' },
  ];
  expect(faceOf(senders, selves)).toEqual({ email: 'ada@example.com' });
});

test('it shows the member when only they wrote, and no one for no senders', () => {
  expect(faceOf([{ email: 'me@example.com' }], selves)).toEqual({ email: 'me@example.com' });
  expect(faceOf([], selves)).toBeUndefined();
});
