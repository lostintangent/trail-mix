import { expect, test } from 'bun:test';
import {
  accountChangeOf,
  draftOf,
  flagsOf,
  instantOf,
  keptOf,
  messagesOf,
  optional,
  pageAtOf,
  refOf,
  setupOf,
  signInOf,
  viewOf,
  waitedOf,
} from './input.ts';

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
  // Only a folder or the unified Inbox shows only its unread conversations, and only when it says so.
  expect(viewOf({ in: 'inbox', unread: true })).toEqual({ in: 'inbox', unread: true });
  expect(viewOf({ in: 'inbox', unread: 'yes' })).toEqual({ in: 'inbox' });
  expect(viewOf({ in: 'flagged', unread: true })).toEqual({ in: 'flagged' });
  expect(viewOf({ in: 'search', text: 'lunch', unread: true })).toEqual({
    in: 'search',
    text: 'lunch',
  });
  expect(() => viewOf({ in: 'everything' })).toThrow(TypeError);
  expect(() => viewOf({ in: 'folder', folder: { account: 'a' } })).toThrow(TypeError);
  expect(() => viewOf('inbox')).toThrow(TypeError);
});

test('a list keeps open a conversation or a bundle it names, or nothing', () => {
  expect(keptOf(undefined)).toBeUndefined();
  expect(keptOf(null)).toBeUndefined();
  expect(keptOf('a:inbox:%3Cx%40y%3E')).toBe('a:inbox:%3Cx%40y%3E');
  for (const kept of ['', 42, ['a'], 'x'.repeat(1001)])
    expect(() => keptOf(kept)).toThrow(TypeError);
});

test('a command’s messages are refs, or a bundle’s through the instant its row showed', () => {
  const ref = { account: 'a', path: 'INBOX', uidValidity: 7, uid: 42 };
  expect(messagesOf([{ ...ref, member: 'eve@example.com' }])).toEqual([ref]);
  const bundle = 'a:trailmix-demo%2Ftoy-box';
  expect(messagesOf({ bundle, through: '2026-11-09T13:00:00+01:00', all: true })).toEqual({
    bundle,
    through: '2026-11-09T12:00:00.000Z',
  });
  for (const named of ['a::%3Cx%40github.com%3E', 'a:toy-box', ':owner%2Frepo', 'a:%E0%A4%A']) {
    expect(() => messagesOf({ bundle: named, through: '2026-11-09T12:00:00Z' })).toThrow(TypeError);
  }
  expect(() => messagesOf({ bundle, through: 'yesterday' })).toThrow(TypeError);
  expect(() => messagesOf({ bundle })).toThrow(TypeError);
});

test('an argument left out before a later one arrives as null, and reads as left out', () => {
  // `send(draft, undefined, 4000)` reaches the Mailroom as `[draft, null, 4000]`.
  expect(optional(null, instantOf)).toBeUndefined();
  expect(optional(undefined, waitedOf)).toBeUndefined();
  expect(optional(4000, waitedOf)).toBe(4000);
  for (const wait of [-1, Number.NaN, Number.POSITIVE_INFINITY, '4000']) {
    expect(() => optional(wait, waitedOf)).toThrow(TypeError);
  }
});

test('a page starts at a place, or around a row named by its id and nothing else', () => {
  expect(pageAtOf(null)).toBe(0);
  expect(pageAtOf(50)).toBe(50);
  expect(pageAtOf({ around: 'c1', member: 'eve@example.com' })).toEqual({ around: 'c1' });
  for (const at of [
    -1,
    1.5,
    '50',
    [],
    { around: 5 },
    { around: '' },
    { around: 'c'.repeat(1001) },
  ]) {
    expect(() => pageAtOf(at)).toThrow(TypeError);
  }
});

test('a flag change names only the four flags, each on or off', () => {
  expect(flagsOf({ seen: true, flagged: false })).toEqual({ seen: true, flagged: false });
  expect(() => flagsOf({ seen: 'true' })).toThrow(TypeError);
  expect(() => flagsOf({ deleted: true })).toThrow(TypeError);
});

test('an account change keeps only a name, a From name, a stamp and a signature', () => {
  expect(accountChangeOf({ name: ' Work ', status: 'ready', allowImagesFrom: ['x'] })).toEqual({
    name: 'Work',
  });
  expect(accountChangeOf({ signature: '' })).toEqual({ signature: '' });
  expect(accountChangeOf({ fromName: ' Ada Lovelace ' })).toEqual({ fromName: 'Ada Lovelace' });
  // Empty, it says to remove the name.
  expect(accountChangeOf({ fromName: '' })).toEqual({ fromName: '' });
  expect(() => accountChangeOf({ fromName: 'Ada\r\nBcc: eve@example.com' })).toThrow(TypeError);
  expect(() => accountChangeOf({ stamp: 'pink' })).toThrow(TypeError);
  expect(() => accountChangeOf({ name: '  ' })).toThrow(TypeError);
});

test('an IMAP account needs both hosts unless a preset supplies them, and keeps its password as typed', () => {
  const host = { host: 'mail.example.com', port: 993, secure: true };
  const account = { provider: 'imap' as const, name: 'Me', address: 'me@example.com' };
  expect(setupOf({ ...account, preset: 'zoho', password: ' p ' })).toEqual({
    ...account,
    preset: 'zoho',
    password: ' p ',
  });
  expect(() => setupOf({ ...account, password: 'p', imap: host })).toThrow(TypeError);
  expect(() =>
    setupOf({ ...account, password: 'p', imap: host, smtp: { ...host, host: 'evil host/x' } }),
  ).toThrow(TypeError);
  expect(() => setupOf({ ...account, preset: 'gmail', password: 'p' })).toThrow(TypeError);
  // Outlook takes no password, and signs in with signIn instead.
  expect(() => setupOf({ ...account, preset: 'outlook', password: 'p' })).toThrow(TypeError);
});

test('a sign-in is for a new account at a preset that signs in, or for an account', () => {
  const account = { name: 'Outlook', address: 'me@outlook.com' };
  expect(signInOf({ ...account, preset: 'outlook', password: 'p' })).toEqual({
    ...account,
    preset: 'outlook',
  });
  expect(signInOf('a1')).toBe('a1');
  // Outlook's hosts are Microsoft's, whatever a browser sends.
  const imap = { host: 'imap.evil.example', port: 993, secure: true };
  expect(signInOf({ ...account, preset: 'outlook', imap, smtp: imap })).toEqual({
    ...account,
    preset: 'outlook',
  });
  expect(() => signInOf({ ...account, preset: 'zoho' })).toThrow(TypeError);
  expect(() => signInOf({ ...account, preset: 'gmail' })).toThrow(TypeError);
  expect(() => signInOf({ ...account })).toThrow(TypeError);
  expect(() => signInOf({ preset: 'outlook', name: 'Outlook', address: 'not an address' })).toThrow(
    TypeError,
  );
});

test('a preset keeps the hosts its account lists, both or neither', () => {
  const imap = { host: 'imap.example.com', port: 993, secure: true };
  const smtp = { host: 'smtp.example.com', port: 465, secure: true };
  const account = { provider: 'imap' as const, name: 'Me', address: 'me@example.com' };
  expect(setupOf({ ...account, preset: 'zoho', password: 'p', imap, smtp })).toEqual({
    ...account,
    preset: 'zoho',
    imap,
    smtp,
    password: 'p',
  });
  // Half a pair would reach one of the account's servers and one of somebody else's.
  expect(() => setupOf({ ...account, preset: 'zoho', password: 'p', imap })).toThrow(TypeError);
  expect(() => setupOf({ ...account, preset: 'zoho', password: 'p', smtp })).toThrow(TypeError);
  expect(() =>
    setupOf({ ...account, preset: 'zoho', password: 'p', imap, smtp: { ...smtp, port: 0 } }),
  ).toThrow(TypeError);
});

test('an account’s From name is one line, and an empty one is no name', () => {
  const account = {
    provider: 'imap' as const,
    name: 'Me',
    address: 'me@example.com',
    preset: 'zoho' as const,
    password: 'p',
  };
  expect(setupOf({ ...account, fromName: ' Ada Lovelace ' })).toEqual({
    ...account,
    fromName: 'Ada Lovelace',
  });
  expect(setupOf({ ...account, fromName: '' })).toEqual(account);
  expect(() => setupOf({ ...account, fromName: 'Ada\nBcc: eve@example.com' })).toThrow(TypeError);
  const outlook = { preset: 'outlook', name: 'Me', address: 'me@outlook.com' } as const;
  expect(signInOf({ ...outlook, fromName: ' Ada ' })).toEqual({ ...outlook, fromName: 'Ada' });
  expect(() => signInOf({ ...outlook, fromName: 'Ada\nBcc: eve@example.com' })).toThrow(TypeError);
});

const ref = { account: 'a', path: 'Drafts', uidValidity: 7, uid: 3 };
const chart = { name: 'chart.png', type: 'image/png', content: new Uint8Array([137, 80]) };
const draft = {
  account: 'a',
  to: [{ name: 'Sam Rivera', email: 'sam@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Lunch',
  markdown: '  Thursday?\n\n![chart](cid:chart@trailmix.invalid)\n',
  attachments: [
    { file: chart, contentId: 'chart@trailmix.invalid' },
    { in: ref, id: '2' },
  ],
};

test('a draft keeps what its message needs, and its Markdown as typed', () => {
  expect(draftOf({ ...draft, from: 'boss@example.com', messageId: '<x@y>' })).toEqual(draft);
  expect(draftOf({ ...draft, inReplyTo: ref }).inReplyTo).toEqual(ref);
});

test('a file’s type is its essence, and one the browser didn’t know is plain bytes', () => {
  const typed = (type: string) =>
    draftOf({ ...draft, attachments: [{ file: { ...chart, type } }] }).attachments[0];
  expect(typed('text/plain;charset=utf-8')).toEqual({ file: { ...chart, type: 'text/plain' } });
  expect(typed('')).toEqual({ file: { ...chart, type: 'application/octet-stream' } });
  expect(typed('Image/PNG')).toEqual({ file: chart });
});

test('every header a draft fills is one line', () => {
  const headerSplitting = [
    { subject: 'Lunch\r\nBcc: eve@example.com' },
    { to: [{ name: 'Sam\nBcc: eve@example.com', email: 'sam@example.com' }] },
    { attachments: [{ file: { ...chart, name: 'chart.png\r\nX: y' } }] },
  ];
  for (const change of headerSplitting) {
    expect(() => draftOf({ ...draft, ...change })).toThrow(TypeError);
  }
});

test('an attachment is a typed file with its bytes, or one held by a message', () => {
  const refused = [
    { file: { ...chart, content: 'iVBORw0KGgo=' } },
    { file: { ...chart, content: [137, 80] } },
    { file: { ...chart, type: 'png' } },
    { file: chart, contentId: '<chart@trailmix.invalid>' },
    { in: ref, id: '../2' },
    { in: { ...ref, uid: 0 }, id: '2' },
  ];
  for (const attachment of refused) {
    expect(() => draftOf({ ...draft, attachments: [attachment] })).toThrow(TypeError);
  }
});
