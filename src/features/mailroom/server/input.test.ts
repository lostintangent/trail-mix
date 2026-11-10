import { expect, test } from 'bun:test';
import { accountChangeOf, flagsOf, refOf, setupOf, viewOf } from './input.ts';

// What a browser sends reaches the Mailroom only through these checks.

test('a ref keeps the four fields that name a message and nothing else', () => {
  const sent = { account: 'a', path: 'INBOX', uidValidity: 7, uid: 42, member: 'eve@example.com' };
  expect(refOf(sent)).toEqual({ account: 'a', path: 'INBOX', uidValidity: 7, uid: 42 });
  for (const uid of [0, -1, 1.5, '42', 2 ** 32]) {
    expect(() => refOf({ ...sent, uid })).toThrow(TypeError);
  }
});

test('a view is one of the shapes a list shows, and a search carries its text', () => {
  expect(viewOf({ in: 'inbox', folder: { account: 'a', path: 'INBOX' } })).toEqual({ in: 'inbox' });
  expect(viewOf({ in: 'search', text: ' lunch ', fullText: 'yes' })).toEqual({
    in: 'search',
    text: 'lunch',
  });
  expect(() => viewOf({ in: 'everything' })).toThrow(TypeError);
  expect(() => viewOf({ in: 'folder', folder: { account: 'a' } })).toThrow(TypeError);
  expect(() => viewOf('inbox')).toThrow(TypeError);
});

test('a flag change names only the four flags, each on or off', () => {
  expect(flagsOf({ seen: true, flagged: false })).toEqual({ seen: true, flagged: false });
  expect(() => flagsOf({ seen: 'true' })).toThrow(TypeError);
  expect(() => flagsOf({ deleted: true })).toThrow(TypeError);
});

test('an account change keeps only a name, a stamp and a signature', () => {
  expect(accountChangeOf({ name: ' Work ', status: 'ready', allowImagesFrom: ['x'] })).toEqual({
    name: 'Work',
  });
  expect(accountChangeOf({ signature: '' })).toEqual({ signature: '' });
  expect(() => accountChangeOf({ stamp: 'pink' })).toThrow(TypeError);
  expect(() => accountChangeOf({ name: '  ' })).toThrow(TypeError);
});

test('an IMAP account needs both hosts unless a preset supplies them, and keeps its password as typed', () => {
  const host = { host: 'mail.example.com', port: 993, secure: true };
  const account = { provider: 'imap' as const, name: 'Me', address: 'me@example.com' };
  expect(setupOf({ ...account, preset: 'zoho', password: ' p ', imap: host })).toEqual({
    ...account,
    preset: 'zoho',
    password: ' p ',
  });
  expect(() => setupOf({ ...account, password: 'p', imap: host })).toThrow(TypeError);
  expect(() =>
    setupOf({ ...account, password: 'p', imap: host, smtp: { ...host, host: 'evil host/x' } }),
  ).toThrow(TypeError);
  expect(() => setupOf({ ...account, preset: 'gmail', password: 'p' })).toThrow(TypeError);
  expect(setupOf({ ...account, preset: 'outlook', password: 'ignored' })).toEqual({
    ...account,
    preset: 'outlook',
  });
});
