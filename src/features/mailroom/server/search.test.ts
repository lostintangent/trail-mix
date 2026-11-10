import { expect, test } from 'bun:test';
import type { Envelope, SyncEvent } from '../../mail/core/index.ts';
import { envelopeIndex } from './envelope-index.ts';
import type { Sql } from './schema.ts';
import { FOUND_LIMIT, foundOf, opened } from './search.ts';
import { testSql } from './test-sql.ts';

let uid = 1;
function envelope(id: string, init: Partial<Envelope> = {}): Envelope {
  return {
    account: 'personal',
    path: 'INBOX',
    uidValidity: 1,
    uid: uid++,
    messageId: `<${id}@example.com>`,
    references: [],
    from: { name: 'Ada Park', email: 'ada@example.com' },
    to: [{ email: 'me@trailmix.test' }],
    cc: [],
    subject: id,
    date: '2026-11-09T12:00:00.000Z',
    preview: id,
    flags: { seen: true, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    ...init,
  };
}

function indexed(...envelopes: Envelope[]) {
  const sql = testSql();
  const store = envelopeIndex(sql);
  store.listFolders('personal', [
    { account: 'personal', path: 'INBOX', name: 'INBOX', role: 'inbox', unread: 0, total: 0 },
    { account: 'personal', path: 'Archive', name: 'Archive', role: 'archive', unread: 0, total: 0 },
  ]);
  store.fold(envelopes.map((e): SyncEvent => ({ type: 'message', envelope: e })));
  return { sql, store };
}

/** Every row of every table, the search table's own included. */
const everything = (sql: Sql) =>
  sql
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .map(({ name }) => [name, sql.all(`SELECT * FROM "${name}"`)]);

test('a hit outside the index opens in the conversation it belongs to, and writes nothing', () => {
  const reply = envelope('Re: Lunch', { references: ['<Lunch@example.com>'] });
  const { sql, store } = indexed(reply, envelope('Garden'));
  const before = everything(sql);

  // The original is older than the window, so only the server's search finds it.
  const original = envelope('Lunch', { path: 'Archive', date: '2024-03-01T12:00:00.000Z' });
  const found = foundOf('lunch', [original, reply], store);

  expect(found.rows.map(({ subject, count }) => [subject, count])).toEqual([['Re: Lunch', 2]]);
  const [row] = found.rows;
  expect(opened(row!.id, store, found.outside).map(({ subject }) => subject)).toEqual([
    'Lunch',
    'Re: Lunch',
  ]);
  expect(everything(sql)).toEqual(before);
});

test('ranks a conversation by its newest hit and shows that hit, as the index’s search does', () => {
  const plans = envelope('Plans', {
    date: '2026-10-01T08:00:00.000Z',
    preview: 'Periwinkle walls.',
  });
  const reply = envelope('Re: Plans', {
    references: [plans.messageId],
    date: '2026-11-09T08:00:00.000Z',
  });
  const paint = envelope('Paint', { date: '2026-11-01T08:00:00.000Z' });
  const { store } = indexed(plans, reply, paint);
  // Only the server's search reads bodies, and it found the word in the old message and in Paint.
  const found = foundOf('periwinkle', [plans, paint], store);
  expect(
    found.rows.map(({ subject, preview, date, count }) => [subject, preview, date, count]),
  ).toEqual([
    ['Paint', 'Paint', '2026-11-01T08:00:00.000Z', 1],
    ['Plans', 'Periwinkle walls.', '2026-10-01T08:00:00.000Z', 2],
  ]);
});

test('keeps only the newest hits, each lone one its own row, newest first', () => {
  const { store } = indexed();
  const hits = Array.from({ length: FOUND_LIMIT + 5 }, (_, i) =>
    envelope(`Old ${i}`, { date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString() }),
  );
  const found = foundOf('old', hits, store);
  expect(found.outside).toHaveLength(FOUND_LIMIT);
  expect(found.rows.map(({ subject }) => subject)).toEqual(
    hits
      .slice(5)
      .reverse()
      .map(({ subject }) => subject),
  );
});

test('a conversation the index holds opens as the index has it when nothing outside joins it', () => {
  const held = envelope('Tickets');
  const { store } = indexed(held, envelope('Other'));
  const found = foundOf('tickets', [held], store);
  expect(found.outside).toEqual([]);
  expect(found.rows).toEqual(
    store.page({ in: 'inbox' }).items.filter((r) => r.subject === 'Tickets'),
  );
});
