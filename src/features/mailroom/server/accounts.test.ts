import { expect, test } from 'bun:test';
import { demoMailbox } from '../../providers/index.ts';
import { accountBook, type Connection } from './accounts.ts';
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
