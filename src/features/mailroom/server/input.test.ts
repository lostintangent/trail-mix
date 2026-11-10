import { expect, test } from 'bun:test';
import { accountChangeOf, draftOf, flagsOf, refOf, setupOf, viewOf } from './input.ts';

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
