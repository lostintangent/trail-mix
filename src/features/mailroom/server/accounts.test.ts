import { expect, test } from 'bun:test';
import { DEMO_ACCOUNTS, demoMailbox, PRESETS } from '../../providers/index.ts';
import { accountBook, connectionOf, demoSettings, type Connection } from './accounts.ts';
import { upgrade } from './schema.ts';
import { testSql } from './test-sql.ts';

const imap: Connection = {
  provider: 'imap',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  user: 'me@example.com',
  filesSent: false,
};
const named = (id: string) => ({
  id,
  name: id,
  address: `${id}@example.com`,
  provider: 'imap' as const,
});
const sealed = { sealed: new Uint8Array([1, 2, 3]) };

test('accounts keep the order they were added in, each with the first stamp not in use', () => {
  const sql = testSql();
  const book = accountBook(sql);
  book.add(named('a'), imap, sealed);
  book.add(named('b'), imap, sealed);
  book.add(named('c'), imap, sealed);
  book.remove('b');
  book.add(named('d'), imap, sealed);
  expect(book.all().map(({ id, stamp }) => [id, stamp])).toEqual([
    ['a', 'vermilion'],
    ['c', 'violet'],
    ['d', 'teal'],
  ]);
});

test('removing an account forgets its secret and its demo server', () => {
  const sql = testSql();
  const book = accountBook(sql);
  book.add(named('mail'), imap, sealed);
  const demo = demoMailbox('personal', 10, '2026-11-09T12:00:00.000Z');
  book.add(
    { ...named('demo'), provider: 'demo' },
    { provider: 'demo', kind: 'personal' },
    { demo },
  );
  expect(book.sealed('mail')).toEqual(sealed.sealed);
  expect(book.demo('demo')).toEqual(demo);

  book.remove('mail');
  book.remove('demo');
  expect(sql.all(`SELECT * FROM credentials`)).toEqual([]);
  expect(sql.all(`SELECT * FROM demo`)).toEqual([]);
  expect(book.all()).toEqual([]);
});

test('the demo is a size and an optional instant, and anything else is refused', () => {
  expect(demoSettings()).toBeUndefined();
  expect(demoSettings('2000')).toEqual({ inbox: 2000 });
  expect(demoSettings('50000', '2026-11-09T13:00:00+01:00')).toEqual({
    inbox: 50000,
    createdAt: '2026-11-09T12:00:00.000Z',
  });
  for (const size of ['0', '-5', '1e4', '2,000', 'lots']) {
    expect(() => demoSettings(size)).toThrow('DEMO_MAILBOX');
  }
  // A date alone, or a time without its offset, could mean a different instant on each machine.
  for (const at of ['2026-11-09', '2026-11-09T12:00:00', 'yesterday', '2026-13-40T12:00:00Z']) {
    expect(() => demoSettings('2000', at)).toThrow('DEMO_MAILBOX_AT');
  }
  expect(() => demoSettings(undefined, '2026-11-09T12:00:00Z')).toThrow('DEMO_MAILBOX_AT');
  // Its mail server files its own copies in Sent only when asked, in so many words.
  expect(demoSettings('2000', undefined, 'true')).toEqual({ inbox: 2000, hostFilesSent: true });
  for (const host of ['1', 'yes', 'false', '']) {
    expect(() => demoSettings('2000', undefined, host)).toThrow('DEMO_HOST_FILES_SENT');
  }
  expect(() => demoSettings(undefined, undefined, 'true')).toThrow('DEMO_HOST_FILES_SENT');
});

test('a demo account from before From names writes as its demo person, and IMAP ones wait for one', () => {
  // Version 4 gave accounts their From names, so this Mailroom stops at the version before it.
  const sql = testSql(3);
  const book = accountBook(sql);
  book.add(named('mail'), imap, sealed);
  const demo = demoMailbox('personal', 10, '2026-11-09T12:00:00.000Z');
  book.add(
    { id: 'demo', name: 'Personal', address: 'sam@trailmix.test', provider: 'demo' },
    { provider: 'demo', kind: 'personal' },
    { demo },
  );
  upgrade(sql);
  expect(book.all().map(({ id, fromName }) => [id, fromName])).toEqual([
    ['mail', undefined],
    ['demo', DEMO_ACCOUNTS.personal.me.name],
  ]);
});

test('an account on Zoho’s hosts from before Zoho was known to file in Sent waits for its copy', () => {
  // Version 9 learned that Zoho files its own copy, so this Mailroom stops at the version before it.
  const sql = testSql(8);
  const book = accountBook(sql);
  const on = (host: string) => ({ ...imap, imap: { ...imap.imap, host } });
  const hosts = ['imappro.zoho.com', 'imap.zoho.eu', 'imap.zohocloud.ca', 'imap.example.com'];
  for (const host of hosts) book.add(named(host), on(host), sealed);
  upgrade(sql);
  expect(book.connections().map(({ connection }) => connection)).toEqual([
    { ...on('imappro.zoho.com'), filesSent: true },
    { ...on('imap.zoho.eu'), filesSent: true },
    { ...on('imap.zohocloud.ca'), filesSent: true },
    on('imap.example.com'),
  ]);
});

test('an account is reached through the hosts it was given, or else its preset’s, with the preset’s quirks', () => {
  const address = 'me@example.com';
  const imap = { host: 'imap.example.com', port: 993, secure: true };
  const smtp = { host: 'smtp.example.com', port: 465, secure: true };
  expect(connectionOf({ address, preset: 'zoho', imap, smtp })).toEqual({
    provider: 'imap',
    imap,
    smtp,
    user: address,
    filesSent: PRESETS.zoho.filesSent,
  });
  expect(connectionOf({ address, preset: 'outlook', imap, smtp }).filesSent).toBe(true);
  expect(connectionOf({ address, preset: 'zoho' })).toMatchObject({
    imap: PRESETS.zoho.imap,
    smtp: PRESETS.zoho.smtp,
  });
  expect(connectionOf({ address, imap, smtp })).toMatchObject({ imap, smtp, filesSent: false });
  expect(() => connectionOf({ address, imap })).toThrow(TypeError);
});
