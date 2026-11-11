import { expect, test } from 'bun:test';
import type { Account } from '../features/mail/core/index.ts';
import { remembered } from './hasMail.ts';

const MAIL = [{ id: 'personal' }] as unknown as Account[];

test('a device remembers its Mailroom by name while it holds accounts, and forgets it once it holds none', () => {
  expect(remembered(undefined, 'room-1', MAIL)).toBe('room-1');
  expect(remembered('room-1', 'room-1', [])).toBeUndefined();
  // Until the Mailroom says its name, what the device held stands.
  expect(remembered('room-1', undefined, undefined)).toBe('room-1');
  expect(remembered('room-1', undefined, [])).toBe('room-1');
  expect(remembered('room-1', 'room-1', undefined)).toBe('room-1');
});

test('an erase, or another member signing in, names the Mailroom anew, which forgets what was held', () => {
  expect(remembered('room-1', 'room-2', undefined)).toBeUndefined();
  expect(remembered('room-1', 'room-2', MAIL)).toBe('room-2');
});
