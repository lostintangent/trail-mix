import { describe, expect, test } from 'bun:test';
import {
  applySyncEvent,
  bundleIdOf,
  isBundle,
  memoryIndex,
  type BundleSummary,
  type ConversationSummary,
  type Envelope,
  type FolderRef,
  type FolderRole,
  type ListItem,
  type MemoryIndex,
  type SyncEvent,
} from '../../mail/core/index.ts';
import type { Page } from '../client/contract.ts';
import { envelopeIndex, type EnvelopeIndex } from './envelope-index.ts';
import { RESUMMARIZE, upgrade, type Sql, type SqlValue } from './schema.ts';
import { testSql } from './test-sql.ts';

const FOLDERS: { account: string; path: string; role?: FolderRole }[] = [
  { account: 'personal', path: 'INBOX', role: 'inbox' },
  { account: 'personal', path: 'Sent', role: 'sent' },
  { account: 'personal', path: 'Archive', role: 'archive' },
  { account: 'personal', path: 'Drafts', role: 'drafts' },
  { account: 'personal', path: 'Junk', role: 'junk' },
  { account: 'personal', path: 'Projects' },
  { account: 'work', path: 'INBOX', role: 'inbox' },
];

function fresh(own: readonly string[] = [], sql: Sql = testSql()): EnvelopeIndex {
  const store = envelopeIndex(sql, () => own);
  for (const account of ['personal', 'work']) {
    store.listFolders(
      account,
      FOLDERS.filter((f) => f.account === account).map((f) => ({
        ...f,
        name: f.path,
        unread: 0,
        total: 0,
      })),
    );
  }
  return store;
}

const FLAGS = { seen: false, flagged: false, answered: false, draft: false };

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
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    verified: false,
    ...init,
  };
}
const arrive = (...envelopes: Envelope[]): SyncEvent[] =>
  envelopes.map((e) => ({ type: 'message', envelope: e }));

/**
 * A Mailroom as the release at `version` left it, holding what `from` holds of the tables that
 * release had, in the columns it had.
 */
function heldAsOf(version: number, from: Sql): Sql {
  const sql = testSql(version);
  for (const table of ['accounts', 'folders', 'messages', 'links', 'conversations', 'placements']) {
    const columns = [
      ...(table === 'messages' ? ['rowid'] : []),
      ...sql
        .all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
        .map((c) => c.name),
    ];
    for (const row of from.all<Record<string, SqlValue>>(
      `SELECT ${columns.join(', ')} FROM ${table}`,
    )) {
      sql.run(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...columns.map((column) => row[column] ?? null),
      );
    }
  }
  return sql;
}

/** A list's conversations, of a list that holds no bundle. */
const conversationsIn = ({ items }: Page) =>
  items.filter((item): item is ConversationSummary => !isBundle(item));

/** A seeded run of arrivals, flag changes, removals and resets over threads that share ids. */
function story(seed: number): SyncEvent[] {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const held: Envelope[] = [];
  const events: SyncEvent[] = [];
  for (let i = 0; i < 60; i++) {
    const roll = random();
    if (roll < 0.6 || held.length === 0) {
      const folder = pick(FOLDERS);
      const parent = held.length && random() < 0.6 ? pick(held) : undefined;
      const message = envelope(`m${seed}-${i}`, {
        account: folder.account,
        path: folder.path,
        references: parent ? [...parent.references, parent.messageId] : [],
        date: new Date(Date.UTC(2026, 10, 1) + Math.floor(random() * 1e9)).toISOString(),
        flags: {
          seen: random() < 0.5,
          flagged: random() < 0.2,
          answered: false,
          draft: folder.role === 'drafts',
        },
        hasAttachments: random() < 0.2,
      });
      held.push(message);
      events.push(...arrive(message));
      if (random() < 0.1) events.push(...arrive(message));
    } else if (roll < 0.75) {
      const message = pick(held);
      events.push({
        type: 'flags',
        ref: message,
        flags: { ...message.flags, seen: !message.flags.seen },
      });
    } else if (roll < 0.95) {
      const message = held.splice(Math.floor(random() * held.length), 1)[0]!;
      events.push({ type: 'gone', ref: message });
    } else {
      const folder = pick(FOLDERS);
      events.push({ type: 'reset', folder: { account: folder.account, path: folder.path } });
      for (let j = held.length - 1; j >= 0; j--) {
        if (held[j]!.account === folder.account && held[j]!.path === folder.path) held.splice(j, 1);
      }
    }
  }
  return events;
}

const sorted = <T>(items: readonly T[]) =>
  [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('the envelope index', () => {
  test('holds exactly what the mail core’s reference index holds, for any run of events', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const events = story(seed);
      const store = fresh();
      let reference: MemoryIndex = memoryIndex(FOLDERS);
      // Batches of uneven size, as sync delivers them.
      for (let i = 0; i < events.length; i += 1 + (seed % 7)) {
        const batch = events.slice(i, i + 1 + (seed % 7));
        store.fold(batch);
        for (const event of batch) reference = reference.apply(applySyncEvent(reference, event));
      }
      const all = FOLDERS.flatMap((folder) => store.reads.folder(folder));
      expect(sorted(all)).toEqual(sorted(reference.messages));
      for (const message of reference.messages) {
        expect(sorted(store.reads.conversation(message.conversation))).toEqual(
          sorted(reference.conversation(message.conversation)),
        );
      }
    }
  });

  test('folding the same batch again changes nothing', () => {
    const store = fresh();
    const events = story(7);
    store.fold(events);
    const before = store.page({ in: 'inbox' }, undefined, 1000);
    store.fold(events);
    expect(store.page({ in: 'inbox' }, undefined, 1000)).toEqual(before);
  });
});

describe('a conversation’s row', () => {
  test('speaks with its latest message and adds up the rest', () => {
    const store = fresh();
    const first = envelope('lunch', {
      date: '2026-11-09T09:00:00.000Z',
      flags: { seen: true, flagged: true, answered: false, draft: false },
    });
    const reply = envelope('re-lunch', {
      path: 'Sent',
      references: [first.messageId],
      from: { email: 'me@trailmix.test' },
      subject: 'Re: lunch',
      preview: 'Friday works',
      date: '2026-11-09T10:00:00.000Z',
      flags: { seen: true, flagged: false, answered: false, draft: false },
      hasAttachments: true,
    });
    const again = envelope('re-re-lunch', {
      references: [first.messageId, reply.messageId],
      subject: 'Re: lunch',
      preview: 'See you',
      date: '2026-11-09T11:00:00.000Z',
    });
    store.fold(arrive(first, reply, again));
    const [row] = store.page({ in: 'inbox' }).items;
    expect(row).toMatchObject({
      account: 'personal',
      subject: 'Re: lunch',
      preview: 'See you',
      date: '2026-11-09T11:00:00.000Z',
      senders: [{ name: 'Ada Park', email: 'ada@example.com' }, { email: 'me@trailmix.test' }],
      count: 3,
      unread: 1,
      flagged: true,
      hasAttachments: true,
    });
  });

  test('names each sender as their newest message does, as GitHub names whoever acted last', () => {
    const store = fresh();
    const asked = envelope('asked', {
      from: { name: 'Theo Lindqvist', email: 'notifications@github.com' },
      date: '2026-11-09T09:00:00.000Z',
    });
    const answered = envelope('answered', {
      references: [asked.messageId],
      from: { name: 'Luca Bianchi', email: 'Notifications@GitHub.com' },
      date: '2026-11-09T10:00:00.000Z',
    });
    store.fold(arrive(answered, asked));
    expect(store.page({ in: 'inbox' }).items[0]).toMatchObject({
      senders: [{ name: 'Luca Bianchi', email: 'Notifications@GitHub.com' }],
    });
  });

  test('names the avatar of its newest sender other than the member, when that message is verified', () => {
    const store = fresh(['Me@TrailMix.test']);
    const news = envelope('news', {
      from: { email: 'news@Brand.Example' },
      date: '2026-11-09T09:00:00.000Z',
      verified: true,
    });
    const reply = envelope('re-news', {
      path: 'Sent',
      references: [news.messageId],
      from: { email: 'me@trailmix.test' },
      date: '2026-11-09T10:00:00.000Z',
      verified: true,
    });
    store.fold(arrive(news, reply));
    const id = store.reads.message(news)!.conversation;
    expect(store.page({ in: 'inbox' }).items[0]?.avatar).toBe('news@brand.example');
    expect(store.summaryOf(id, store.conversation(id))?.avatar).toBe('news@brand.example');

    // A newer sender who isn't verified takes the row, avatar and all.
    const forwarded = envelope('fwd-news', {
      references: [news.messageId, reply.messageId],
      from: { email: 'pat@person.example' },
      date: '2026-11-09T11:00:00.000Z',
    });
    store.fold(arrive(forwarded));
    expect(store.page({ in: 'inbox' }).items[0]).not.toHaveProperty('avatar');
  });

  test('names its latest message’s recipients, To and then Cc', () => {
    const store = fresh(['me@trailmix.test']);
    const ask = envelope('ask', { date: '2026-11-09T09:00:00.000Z' });
    const reply = envelope('re-ask', {
      path: 'Sent',
      references: [ask.messageId],
      from: { email: 'me@trailmix.test' },
      to: [{ name: 'Ada Park', email: 'ada@example.com' }],
      cc: [{ name: 'Theo Lindqvist', email: 'theo@example.com' }],
      date: '2026-11-09T10:00:00.000Z',
    });
    store.fold(arrive(ask, reply));
    expect(conversationsIn(store.page({ in: 'inbox' }))[0]?.recipients).toEqual([
      { name: 'Ada Park', email: 'ada@example.com' },
      { name: 'Theo Lindqvist', email: 'theo@example.com' },
    ]);
  });

  test('pictures its first recipient other than the member when only they wrote', () => {
    const store = fresh(['Me@TrailMix.test', 'me@work.trailmix.test']);
    const sent = (id: string, to: Envelope['to'], cc: Envelope['cc'] = []) =>
      envelope(id, { path: 'Sent', from: { email: 'me@trailmix.test' }, to, cc });
    store.fold(
      arrive(
        sent('to-rae', [
          { name: 'Rae Chen', email: 'Rae@Example.com' },
          { email: 'theo@example.com' },
        ]),
        sent(
          'to-self-cc-rae',
          [{ email: 'me@work.trailmix.test' }],
          [{ email: 'rae@example.com' }],
        ),
        sent('to-self', [{ email: 'ME@trailmix.test' }]),
        sent('to-nobody', []),
      ),
    );
    const avatars = conversationsIn(
      store.page({ in: 'folder', folder: { account: 'personal', path: 'Sent' } }),
    ).map(({ subject, avatar }) => [subject, avatar]);
    expect(Object.fromEntries(avatars)).toEqual({
      'to-rae': 'rae@example.com',
      'to-self-cc-rae': 'rae@example.com',
      'to-self': undefined,
      'to-nobody': undefined,
    });
  });

  test('pictures no recipient when anyone else wrote, verified or not', () => {
    const store = fresh(['me@trailmix.test']);
    const theirs = envelope('theirs', { date: '2026-11-09T09:00:00.000Z' });
    const reply = envelope('re-theirs', {
      path: 'Sent',
      references: [theirs.messageId],
      from: { email: 'me@trailmix.test' },
      to: [{ email: 'rae@example.com' }],
      date: '2026-11-09T10:00:00.000Z',
    });
    store.fold(arrive(theirs, reply));
    expect(store.page({ in: 'inbox' }).items[0]).not.toHaveProperty('avatar');
  });

  test('learns its recipients, and its first recipient’s picture, as its Mailroom upgrades', () => {
    // A Mailroom as the release before rows named recipients left it, whose rows the current fold
    // wrote, less what that release didn't write.
    const current = testSql();
    current.run(
      `INSERT INTO accounts (id, position, account, connection) VALUES ('personal', 0, ?, '{}')`,
      JSON.stringify({ address: 'Me@TrailMix.test' }),
    );
    const store = fresh(['Me@TrailMix.test'], current);
    const ask = envelope('ask', { verified: true, date: '2026-11-09T09:00:00.000Z' });
    const me = { email: 'me@trailmix.test' };
    store.fold(
      arrive(
        ask,
        envelope('re-ask', {
          path: 'Sent',
          references: [ask.messageId],
          from: me,
          to: [{ email: 'ada@example.com' }],
          date: '2026-11-09T10:00:00.000Z',
        }),
        envelope('pat', { from: { email: 'pat@example.com' } }),
        envelope('to-rae', {
          path: 'Sent',
          from: me,
          to: [me, { name: 'Rae Chen', email: ' Rae@Example.com' }],
          cc: [{ email: 'theo@example.com' }],
          date: '2026-11-09T11:00:00.000Z',
        }),
        envelope('to-jo', {
          path: 'Sent',
          from: me,
          to: [{ email: 'jo@example.com' }],
          date: '2026-11-09T11:00:00.000Z',
        }),
        envelope('later-to-theo', {
          path: 'Sent',
          from: me,
          references: ['<to-jo@example.com>'],
          to: [{ email: 'theo@example.com' }],
          date: '2026-11-09T12:00:00.000Z',
        }),
        envelope('to-self', { path: 'Sent', from: me, to: [me] }),
        envelope('to-nobody', { path: 'Drafts', from: me, to: [] }),
        envelope('to-undisclosed', {
          path: 'Sent',
          from: me,
          to: [{ name: 'undisclosed-recipients', email: '' }, { email: 'rae' }],
        }),
        envelope('past-a-malformed-address', {
          path: 'Sent',
          from: me,
          to: [{ email: 'a@b@' }, { email: 'kai@example.com' }],
        }),
      ),
    );
    const rows = (sql: Sql) =>
      sql
        .all<{ id: string; summary: string }>(`SELECT id, summary FROM conversations ORDER BY id`)
        .map(({ id, summary }) => [id, JSON.parse(summary) as Record<string, unknown>] as const);
    const folded = rows(current);
    const sql = heldAsOf(16, current);
    for (const [id, row] of folded) {
      const { recipients: _, ...before } = row;
      const isOwn = (row['senders'] as { email: string }[]).every(
        ({ email }) => email.toLowerCase() === 'me@trailmix.test',
      );
      if (isOwn) delete before['avatar'];
      sql.run(`UPDATE conversations SET summary = ? WHERE id = ?`, JSON.stringify(before), id);
    }
    expect(folded.map(([, row]) => row['avatar']).toSorted()).toEqual([
      'ada@example.com',
      'kai@example.com',
      'rae@example.com',
      'theo@example.com',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    upgrade(sql);
    expect(rows(sql)).toEqual(folded);
  });

  test('reads mail indexed before senders were verified as unverified', () => {
    const sql = testSql();
    const store = envelopeIndex(sql);
    const old = envelope('old', { verified: true });
    store.fold(arrive(old));
    sql.run(`UPDATE messages SET message = json_remove(message, '$.verified')`);
    expect(store.reads.message(old)?.verified).toBe(false);
  });

  test('knows the senders of the verified mail it holds', () => {
    const store = fresh();
    store.fold(
      arrive(
        envelope('a', { from: { email: 'news@Brand.Example' }, verified: true }),
        envelope('b', { from: { email: 'deals@brand.example' }, verified: true }),
        envelope('c', { from: { email: 'pat@person.example' } }),
      ),
    );
    expect(store.verifiedSenders()).toEqual(new Set(['news@brand.example', 'deals@brand.example']));
  });

  test('leaves every list once its last message is gone', () => {
    const store = fresh();
    const only = envelope('alone', {
      flags: { seen: false, flagged: true, answered: false, draft: false },
    });
    store.fold(arrive(only));
    store.fold([{ type: 'gone', ref: only }]);
    for (const view of [
      { in: 'inbox' },
      { in: 'flagged' },
      { in: 'folder', folder: { account: 'personal', path: 'INBOX' } },
    ] as const) {
      expect(store.page(view).items).toEqual([]);
    }
  });
});

describe('a list', () => {
  test('pages newest first through every conversation once, however the dates tie', () => {
    const store = fresh();
    const dates = ['2026-11-01', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-02'];
    store.fold(
      arrive(
        ...Array.from({ length: 23 }, (_, i) =>
          envelope(`page-${i}`, { date: `${dates[i % 5]}T08:00:00.000Z` }),
        ),
      ),
    );
    const seen: string[] = [];
    for (let at = 0; at < 23; at += 5) {
      const page = store.page({ in: 'inbox' }, at, 5);
      expect([page.at, page.total]).toEqual([at, 23]);
      seen.push(...page.items.map((item) => `${item.date} ${item.id}`));
    }
    expect(store.page({ in: 'inbox' }, 25, 5)).toEqual({ items: [], at: 25, total: 23 });
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  test('of a folder holds the conversations with a message there; the unified ones go by role', () => {
    const store = fresh();
    const project = envelope('project', { path: 'Projects' });
    const draft = envelope('draft', {
      path: 'Drafts',
      flags: { seen: true, flagged: false, answered: false, draft: true },
    });
    const work = envelope('work', {
      account: 'work',
      flags: { seen: false, flagged: true, answered: false, draft: false },
    });
    const junk = envelope('junk', { path: 'Junk' });
    store.fold(arrive(project, draft, work, junk));
    const subjects = (view: Parameters<EnvelopeIndex['page']>[0]) =>
      conversationsIn(store.page(view)).map((item) => item.subject);
    expect(subjects({ in: 'folder', folder: { account: 'personal', path: 'Projects' } })).toEqual([
      'project',
    ]);
    expect(subjects({ in: 'inbox' })).toEqual(['work']);
    expect(subjects({ in: 'drafts' })).toEqual(['draft']);
    expect(subjects({ in: 'flagged' })).toEqual(['work']);
  });
});

/** A verified notification of a repository's pull request, as GitHub sends one. */
function notification(repository: string, number: number, init: Partial<Envelope> = {}): Envelope {
  const [owner, repo] = repository.split('/') as [string, string];
  return envelope(`${repository}#${number}`, {
    messageId: `<${repository}/pull/${number}/c${uid}@github.com>`,
    references: [`<${repository}/pull/${number}@github.com>`],
    from: { name: 'Luca Bianchi', email: 'notifications@github.com' },
    to: [{ email: `${repo}@noreply.github.com` }],
    cc: [{ name: 'Comment', email: 'comment@noreply.github.com' }],
    subject: `Re: [${repository}] Change ${number} (PR #${number})`,
    list: { id: `${repo}.${owner}.github.com` },
    verified: true,
    ...init,
  });
}

const INBOX: FolderRef = { account: 'personal', path: 'INBOX' };
const at = (hour: number) => `2026-11-09T${String(hour).padStart(2, '0')}:00:00.000Z`;

/** What a list shows, row by row: a conversation's subject, or a bundle's repository and threads. */
const shown = (items: readonly ListItem[]) =>
  items.map((item) => (isBundle(item) ? `${item.repository} ×${item.threads}` : item.subject));

describe('a GitHub bundle', () => {
  test('lists a repository’s notification threads in an Inbox as one row, placed by the newest', () => {
    const store = fresh();
    store.fold(
      arrive(
        notification('o/r', 1, { date: at(9) }),
        notification('o/r', 2, { date: at(11) }),
        notification('o/r', 2, { date: at(12), flags: { ...FLAGS, seen: true } }),
        notification('o/s', 3, { date: at(8) }),
        envelope('lunch', { date: at(10) }),
      ),
    );
    for (const view of [{ in: 'inbox' }, { in: 'folder', folder: INBOX }] as const) {
      const page = store.page(view);
      expect(shown(page.items)).toEqual(['o/r ×2', 'lunch', 'o/s ×1']);
      expect(page.total).toBe(3);
    }
    const [bundle] = store.page({ in: 'inbox' }).items as [BundleSummary];
    expect(bundle).toMatchObject({
      id: bundleIdOf('personal', 'o/r'),
      date: at(12),
      threads: 2,
      count: 3,
      unread: 2,
      newest: { kind: 'pull', number: 2, title: 'Change 2' },
    });
  });

  test('pages its conversations newest first, with its row', () => {
    const store = fresh();
    store.fold(
      arrive(...Array.from({ length: 7 }, (_, i) => notification('o/r', i + 1, { date: at(i) }))),
    );
    const id = bundleIdOf('personal', 'o/r');
    const seen: number[] = [];
    for (let place = 0; place < 7; place += 3) {
      const page = store.bundle(id, place, 3);
      expect([page.at, page.total, page.bundle?.threads]).toEqual([place, 7, 7]);
      seen.push(...page.items.map((item) => item.github?.number ?? 0));
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(store.bundle(bundleIdOf('personal', 'o/none'))).toEqual({ items: [], at: 0, total: 0 });
  });

  test('is each account’s own, in the unified Inbox and in each account’s Inbox', () => {
    const store = fresh();
    store.fold(
      arrive(
        notification('o/r', 1, { date: at(9) }),
        notification('o/r', 2, { account: 'work', date: at(10) }),
      ),
    );
    expect(store.page({ in: 'inbox' }).items.map(({ id }) => id)).toEqual([
      bundleIdOf('work', 'o/r'),
      bundleIdOf('personal', 'o/r'),
    ]);
    expect(
      store
        .page({ in: 'folder', folder: { account: 'work', path: 'INBOX' } })
        .items.map((i) => i.id),
    ).toEqual([bundleIdOf('work', 'o/r')]);
  });

  test('lets a conversation go while mail that isn’t its thread’s is in its Inbox, and takes it back after', () => {
    const store = fresh(['me@trailmix.test']);
    const thread = notification('o/r', 1, { date: at(9) });
    store.fold(arrive(thread, notification('o/r', 2, { date: at(10) })));
    const aside = envelope('a word about it', {
      references: [...thread.references, thread.messageId],
      date: at(11),
    });
    // The member's own reply, in Sent, keeps it in the bundle.
    const replied = envelope('replied', {
      path: 'Sent',
      from: { email: 'me@trailmix.test' },
      references: [...thread.references, thread.messageId],
      date: at(12),
    });
    store.fold(arrive(replied));
    expect(shown(store.page({ in: 'inbox' }).items)).toEqual(['o/r ×2']);
    store.fold(arrive(aside));
    // A row speaks with its latest message, the member's reply.
    expect(shown(store.page({ in: 'inbox' }).items)).toEqual(['replied', 'o/r ×1']);
    store.fold([{ type: 'gone', ref: aside }]);
    expect(shown(store.page({ in: 'inbox' }).items)).toEqual(['o/r ×2']);
  });

  test('lets a conversation go with its last Inbox message, and goes with its last conversation', () => {
    const store = fresh();
    const first = notification('o/r', 1, { date: at(9) });
    const second = notification('o/r', 2, { date: at(10) });
    store.fold(arrive(first, second));
    const archived = (message: Envelope): SyncEvent[] => [
      { type: 'gone', ref: message },
      ...arrive({ ...message, path: 'Archive', uid: message.uid + 1000 }),
    ];
    store.fold(archived(second));
    expect(shown(store.page({ in: 'inbox' }).items)).toEqual(['o/r ×1']);
    expect(store.page({ in: 'inbox' }).items[0]?.date).toBe(at(9));
    store.fold(archived(first));
    expect(store.page({ in: 'inbox' })).toEqual({ items: [], at: 0, total: 0 });
    // Out of the Inbox, each is a conversation of its own again.
    expect(
      shown(store.page({ in: 'folder', folder: { account: 'personal', path: 'Archive' } }).items),
    ).toEqual(['Re: [o/r] Change 2 (PR #2)', 'Re: [o/r] Change 1 (PR #1)']);
  });

  test('pages through conversations and bundles together exactly once, however the dates tie', () => {
    const store = fresh();
    const dates = ['2026-11-01', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-02'];
    const date = (i: number) => `${dates[i % 5]}T08:00:00.000Z`;
    store.fold(
      arrive(
        ...Array.from({ length: 17 }, (_, i) => envelope(`page-${i}`, { date: date(i) })),
        ...Array.from({ length: 6 }, (_, i) =>
          notification(`o/r${i}`, i + 1, { date: date(i + 2) }),
        ),
      ),
    );
    for (const view of [{ in: 'inbox' }, { in: 'folder', folder: INBOX }] as const) {
      const seen: string[] = [];
      for (let place = 0; place < 23; place += 5) {
        const page = store.page(view, place, 5);
        expect([page.at, page.total]).toEqual([place, 23]);
        seen.push(...page.items.map((item) => `${item.date} ${item.id}`));
      }
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      expect(seen).toEqual([...seen].sort().reverse());
    }
  });

  test('folding the same events again changes nothing', () => {
    const store = fresh();
    const events = arrive(
      notification('o/r', 1, { date: at(9) }),
      notification('o/r', 2, { date: at(10) }),
      envelope('lunch', { date: at(11) }),
    );
    store.fold(events);
    const id = bundleIdOf('personal', 'o/r');
    const before = [store.page({ in: 'inbox' }), store.bundle(id)];
    store.fold(events);
    expect([store.page({ in: 'inbox' }), store.bundle(id)]).toEqual(before);
  });

  test('a change to it reaches its Inbox messages, every message, or each thread’s newest, up to its row’s date', () => {
    const store = fresh();
    const one = notification('o/r', 1, { date: at(9) });
    const two = notification('o/r', 1, { date: at(10) });
    const three = notification('o/r', 2, { date: at(11) });
    const later = notification('o/r', 2, { date: at(13) });
    const archived = notification('o/r', 1, { path: 'Archive', date: at(8) });
    store.fold(arrive(one, two, three, later, archived));
    const id = bundleIdOf('personal', 'o/r');
    const subjects = (reach: 'inbox' | 'every' | 'newest') =>
      store
        .bundled(id, at(12), reach)
        .map(({ path, date }) => `${path} ${date.slice(11, 13)}`)
        .toSorted();
    expect(subjects('inbox')).toEqual(['INBOX 09', 'INBOX 10', 'INBOX 11']);
    expect(subjects('every')).toEqual(['Archive 08', 'INBOX 09', 'INBOX 10', 'INBOX 11']);
    expect(subjects('newest')).toEqual(['INBOX 10', 'INBOX 11']);
  });
});

describe('an upgrade that makes rows again', () => {
  /** Notifications and a conversation, as the release before bundles held them. */
  function beforeBundles() {
    const current = testSql();
    const now = fresh([], current);
    now.fold(
      arrive(
        ...Array.from({ length: 5 }, (_, i) => notification('o/r', i + 1, { date: at(i + 1) })),
        envelope('lunch', { date: at(9) }),
      ),
    );
    const sql = heldAsOf(19, current);
    sql.run(`UPDATE conversations SET summary = json_remove(summary, '$.github')`);
    upgrade(sql);
    return { sql, store: envelopeIndex(sql, () => []), now };
  }

  test('gathers the notifications into bundles a batch at a time, and every row stays listed meanwhile', () => {
    const { store, now } = beforeBundles();
    expect(shown(store.page({ in: 'inbox' }).items)).toHaveLength(6);
    const changed: FolderRef[][] = [];
    for (let batches = 0; ; batches++) {
      expect(batches).toBeLessThan(4);
      const { changed: folders, done } = store.resummarize(2);
      changed.push(folders);
      const { items } = store.page({ in: 'inbox' });
      const listed = items.reduce((sum, item) => sum + (isBundle(item) ? item.threads : 1), 0);
      expect(listed).toBe(6);
      if (done) break;
    }
    expect(changed.flat()).toContainEqual(INBOX);
    expect(store.page({ in: 'inbox' })).toEqual(now.page({ in: 'inbox' }));
    const id = bundleIdOf('personal', 'o/r');
    expect(store.bundle(id)).toEqual(now.bundle(id));
  });

  test('picks up from where a wake stopped, and once done, changes nothing more', () => {
    const { sql, store, now } = beforeBundles();
    store.resummarize(2);
    // A new instance after an eviction reads the cursor from storage.
    const woken = envelopeIndex(sql, () => []);
    while (!woken.resummarize(2).done);
    expect(woken.page({ in: 'inbox' })).toEqual(now.page({ in: 'inbox' }));
    expect(woken.resummarize(2)).toEqual({ changed: [], done: true });
  });

  test('notes no folder of a row it makes as it was', () => {
    const sql = testSql();
    const store = fresh([], sql);
    store.fold(arrive(envelope('lunch'), envelope('dinner', { path: 'Projects' })));
    // The statement a later version runs, over rows this release already made.
    sql.run(RESUMMARIZE);
    expect(store.resummarize(10)).toEqual({ changed: [], done: true });
  });

  test('a new Mailroom has no rows to make again', () => {
    expect(testSql().all(`SELECT * FROM resummarize`)).toEqual([]);
  });
});

describe('search', () => {
  /** The subjects of every conversation a search finds, newest first. */
  const found = (store: EnvelopeIndex, text: string) =>
    store.search(text).items.map((item) => item.subject);

  test('finds a word as it is typed in senders, recipients, subjects and previews', () => {
    const store = fresh();
    store.fold(
      arrive(
        envelope('From Mina', { from: { name: 'Mina Okafor', email: 'mina@example.org' } }),
        envelope('To Ravi', { to: [{ name: 'Ravi Shah', email: 'ravi@example.net' }] }),
        envelope('Cc Lee', { cc: [{ email: 'lee@corp.example' }] }),
        envelope('Garden plans', { preview: 'The tomatoes are in.' }),
      ),
    );
    expect(found(store, 'oka')).toEqual(['From Mina']);
    expect(found(store, 'ravi@exam')).toEqual(['To Ravi']);
    expect(found(store, 'corp')).toEqual(['Cc Lee']);
    expect(found(store, 'garden')).toEqual(['Garden plans']);
    expect(found(store, 'tomat')).toEqual(['Garden plans']);
  });

  test('needs every word, ignores case and accents, and reads anything typed as words', () => {
    const store = fresh();
    store.fold(
      arrive(
        envelope('Café on Friday', { date: '2026-11-02T08:00:00.000Z' }),
        envelope('Friday standup', { date: '2026-11-01T08:00:00.000Z' }),
      ),
    );
    expect(found(store, 'FRIDAY')).toEqual(['Café on Friday', 'Friday standup']);
    expect(found(store, 'cafe fri')).toEqual(['Café on Friday']);
    expect(found(store, 'café standup')).toEqual([]);
    // FTS5's own syntax is just more words.
    expect(found(store, 'friday OR NEAR( "* ^')).toEqual([]);
    expect(store.search('  "* ')).toEqual({ items: [], at: 0, total: 0 });
  });

  test('finds a ligature or a fullwidth word by its plain form, and the other way round', () => {
    const store = fresh();
    store.fold(
      arrive(
        envelope('Oﬃce ﬁle', { date: '2026-11-02T08:00:00.000Z' }),
        envelope('Ｔｏｋｙｏ office file', { date: '2026-11-01T08:00:00.000Z' }),
      ),
    );
    expect(found(store, 'office file')).toEqual(['Oﬃce ﬁle', 'Ｔｏｋｙｏ office file']);
    expect(found(store, 'oﬃ ﬁ')).toEqual(['Oﬃce ﬁle', 'Ｔｏｋｙｏ office file']);
    expect(found(store, 'tokyo')).toEqual(['Ｔｏｋｙｏ office file']);
    expect(found(store, 'ｔｏｋ')).toEqual(['Ｔｏｋｙｏ office file']);
  });

  test('finds across every account, one row per conversation, and pages newest first', () => {
    const store = fresh();
    const first = envelope('Lunch', { date: '2026-11-01T08:00:00.000Z' });
    store.fold(
      arrive(
        first,
        envelope('Re: Lunch', {
          references: [first.messageId],
          path: 'Sent',
          date: '2026-11-02T08:00:00.000Z',
        }),
        ...Array.from({ length: 6 }, (_, i) =>
          envelope(`Lunch ${i}`, { account: 'work', date: `2026-11-0${3 + i}T08:00:00.000Z` }),
        ),
      ),
    );
    const rows: string[] = [];
    for (let at = 0; at < 7; at += 3) {
      const page = store.search('lunch', at, 3);
      expect([page.at, page.total]).toEqual([at, 7]);
      rows.push(...page.items.map((item) => `${item.account} ${item.subject}`));
    }
    expect(rows).toEqual([
      ...[5, 4, 3, 2, 1, 0].map((i) => `work Lunch ${i}`),
      'personal Re: Lunch',
    ]);
  });

  test('ranks a conversation by its newest message that matches, and shows that message', () => {
    const store = fresh();
    const budget = envelope('Budget review', {
      date: '2026-10-01T08:00:00.000Z',
      preview: 'The budget for next year.',
    });
    store.fold(
      arrive(
        budget,
        // This morning's reply doesn't say the word, so it doesn't lift the conversation.
        envelope('Sounds good', {
          references: [budget.messageId],
          date: '2026-11-09T08:00:00.000Z',
          preview: 'See you then.',
        }),
        envelope('Budget numbers', { date: '2026-11-05T08:00:00.000Z' }),
      ),
    );
    const rows = store.search('budget').items;
    expect(
      rows.map(({ subject, preview, date, count }) => [subject, preview, date, count]),
    ).toEqual([
      ['Budget numbers', 'Budget numbers', '2026-11-05T08:00:00.000Z', 1],
      ['Budget review', 'The budget for next year.', '2026-10-01T08:00:00.000Z', 2],
    ]);
    // The rest of the row is still the conversation's.
    expect(rows[1]!.senders).toEqual(conversationsIn(store.page({ in: 'inbox' }))[0]!.senders);
  });

  test('pages through every matching conversation exactly once, by its newest match', () => {
    const store = fresh();
    const day = (n: number) => new Date(Date.UTC(2026, 10, n, 8)).toISOString();
    // Kiwi pie matches on day 10 and again on day 5, and Fig, which ends the first page, on day 9
    // and again on day 2, so each matches on both sides of a page boundary.
    const kiwi = envelope('Kiwi pie', { date: day(10) });
    const fig = envelope('Fig kiwi jam', { date: day(9) });
    store.fold(
      arrive(
        kiwi,
        fig,
        envelope('Re: Kiwi pie', { references: [kiwi.messageId], date: day(5) }),
        envelope('Re: Fig kiwi jam', { references: [fig.messageId], date: day(2) }),
        ...[8, 7, 6, 4, 3, 1].map((n) => envelope(`Kiwi ${n}`, { date: day(n) })),
        envelope('Plum tart', { date: day(11) }),
      ),
    );
    const rows: string[] = [];
    for (let at = 0; at < 8; at += 2) {
      const page = store.search('kiwi', at, 2);
      expect(page.total).toBe(8);
      rows.push(...page.items.map(({ subject }) => subject));
    }
    expect(rows).toEqual([
      'Kiwi pie',
      'Fig kiwi jam',
      'Kiwi 8',
      'Kiwi 7',
      'Kiwi 6',
      'Kiwi 4',
      'Kiwi 3',
      'Kiwi 1',
    ]);
  });

  test('a search lists only its newest conversations up to its limit, and counts no further', () => {
    const store = fresh();
    const day = (n: number) => new Date(Date.UTC(2026, 10, n, 8)).toISOString();
    const kiwi = envelope('Kiwi pie', { date: day(10) });
    store.fold(
      arrive(
        kiwi,
        envelope('Re: Kiwi pie', { references: [kiwi.messageId], date: day(9) }),
        ...[8, 7, 6, 5].map((n) => envelope(`Kiwi ${n}`, { date: day(n) })),
      ),
    );
    const listed = (at: number) => store.search('kiwi', at, 2, 3);

    expect(
      [listed(0), listed(2), listed(4)].map(({ items, total }) => [items.length, total]),
    ).toEqual([
      [2, 3],
      [1, 3],
      [0, 3],
    ]);
    expect([...listed(0).items, ...listed(2).items].map(({ subject }) => subject)).toEqual([
      'Kiwi pie',
      'Kiwi 8',
      'Kiwi 7',
    ]);
    expect(store.search('kiwi', 0, 2, 10).total).toBe(5);
  });

  test('a message re-flagged or re-linked keeps its place', () => {
    const store = fresh();
    const day = (n: number) => new Date(Date.UTC(2026, 10, n, 8)).toISOString();
    const pie = envelope('Kiwi pie', { date: day(8) });
    const tart = envelope('Kiwi tart', { date: day(4) });
    store.fold(arrive(pie, tart, envelope('Kiwi jam', { date: day(6) })));
    const before = store.search('kiwi').items.map(({ subject, date }) => [subject, date]);
    expect(before.map(([subject]) => subject)).toEqual(['Kiwi pie', 'Kiwi jam', 'Kiwi tart']);

    store.fold([{ type: 'flags', ref: tart, flags: { ...tart.flags, seen: true, flagged: true } }]);
    expect(store.search('kiwi').items.map(({ subject, date }) => [subject, date])).toEqual(before);

    // A reply to both pie and tart joins them, so the tart moves into the pie's conversation.
    store.fold(
      arrive(envelope('Recipes', { references: [pie.messageId, tart.messageId], date: day(9) })),
    );
    const rows = store.search('kiwi', undefined, 1);
    expect(rows.items.map(({ subject, date, count }) => [subject, date, count])).toEqual([
      ['Kiwi pie', day(8), 3],
    ]);
    expect(rows.total).toBe(2);
    const rest = store.search('kiwi', 1, 1);
    expect(rest.items.map(({ subject }) => subject)).toEqual(['Kiwi jam']);
  });

  test('forgets a message the moment the index does', () => {
    const store = fresh();
    const gone = envelope('Periwinkle');
    store.fold(arrive(gone, envelope('Kept', { account: 'work', preview: 'periwinkle too' })));
    store.fold([{ type: 'gone', ref: gone }]);
    expect(found(store, 'periwinkle')).toEqual(['Kept']);
    store.forget('work');
    expect(found(store, 'periwinkle')).toEqual([]);
  });

  test('a message that arrives and goes in one fold leaves no search row', () => {
    const sql = testSql();
    const store = envelopeIndex(sql);
    const brief = envelope('Fleeting');
    store.fold([...arrive(brief, envelope('Kept')), { type: 'gone', ref: brief }]);
    expect(sql.all(`SELECT subject FROM search`)).toEqual([{ subject: 'Kept' }]);
  });

  test('keeps no word of an account it forgot anywhere on disk', () => {
    const sql = testSql();
    const store = envelopeIndex(sql);
    // Folded one at a time, each message lands in a segment of its own.
    for (let i = 0; i < 50; i++) store.fold(arrive(envelope(`Zanzibar${i}`)));
    store.forget('personal');
    const blocks = sql
      .all<{ block: Uint8Array }>(`SELECT block FROM search_data`)
      .map(({ block }) => new TextDecoder('latin1').decode(block))
      .join('');
    expect(blocks.toLowerCase()).not.toContain('zanzibar');
  });
});

describe('the people an address completes to', () => {
  const ME = 'me@trailmix.test';
  const hour = (n: number) => new Date(Date.UTC(2026, 10, 9, n)).toISOString();
  const from = (name: string, email: string, init: Partial<Envelope> = {}) =>
    envelope(`${email}-${uid}`, { from: { name, email }, ...init });
  const sent = (to: string[], init: Partial<Envelope> = {}) =>
    envelope(`sent-${uid}`, {
      path: 'Sent',
      from: { email: ME },
      to: to.map((email) => ({ email })),
      ...init,
    });
  const completed = (store: EnvelopeIndex, typed: string) =>
    store.people(typed).map(({ email }) => email);
  const fill = (store: EnvelopeIndex) => {
    for (let batches = 0; store.fillPeople(2); batches++) expect(batches).toBeLessThan(100);
  };

  test('ranks those the member wrote to first, then those who wrote to them, by how often and then how lately', () => {
    const store = fresh([ME]);
    store.fold(
      arrive(
        from('Ada Park', 'ada@example.com', { date: hour(1) }),
        from('Ada Park', 'ada@example.com', { date: hour(2) }),
        from('Ada Park', 'ada@example.com', { date: hour(3) }),
        from('Bo Lin', 'bo@example.com', { date: hour(4) }),
        from('Cy Moss', 'cy@example.com', { date: hour(5) }),
        sent(['rae@example.com'], { date: hour(1) }),
        sent(['theo@example.com', 'ada@example.com'], { date: hour(2) }),
        sent(['theo@example.com'], { date: hour(3) }),
      ),
    );
    expect(completed(store, 'example')).toEqual([
      'theo@example.com',
      'ada@example.com',
      'rae@example.com',
      'cy@example.com',
      'bo@example.com',
    ]);
    expect(store.people('example', 2)).toEqual([
      { email: 'theo@example.com' },
      { name: 'Ada Park', email: 'ada@example.com' },
    ]);
  });

  test('names someone by the newest name they gave themselves, else the newest the member wrote to them by', () => {
    const store = fresh([ME]);
    const toThem = (name: string, email: string, date: string) =>
      sent([], { to: [{ name, email }], date });
    store.fold(
      arrive(
        from('Ada Park', 'ada@example.com', { date: hour(1) }),
        from('Ada P.', 'ada@example.com', { date: hour(3) }),
        from('', 'ada@example.com', { date: hour(4) }),
        toThem('Ada at school', 'ada@example.com', hour(5)),
        toThem('Rae', 'rae@example.com', hour(1)),
        toThem('Rae Chen', 'rae@example.com', hour(2)),
      ),
    );
    expect(store.people('example')).toEqual([
      { name: 'Rae Chen', email: 'rae@example.com' },
      { name: 'Ada P.', email: 'ada@example.com' },
    ]);
  });

  test('matches the start of a word of a name or an address for every word typed, ignoring case and accents', () => {
    const store = fresh([ME]);
    store.fold(
      arrive(
        from('Zoë Ångström', 'zoe.a@example.org'),
        from('Zola Kim', 'zk@example.net'),
        from('Me Again', ME),
      ),
    );
    expect(completed(store, 'zo')).toEqual(['zk@example.net', 'zoe.a@example.org']);
    expect(completed(store, 'ZOE')).toEqual(['zoe.a@example.org']);
    expect(completed(store, 'zo ang')).toEqual(['zoe.a@example.org']);
    expect(completed(store, 'zoe.a@ex')).toEqual(['zoe.a@example.org']);
    expect(completed(store, 'kim zo')).toEqual(['zk@example.net']);
    expect(completed(store, 'oe')).toEqual([]);
    expect(completed(store, 'me')).toEqual([]);
    expect(completed(store, ' @ ')).toEqual([]);
  });

  test('counts each message once, however many folders hold it and however often it folds', () => {
    const store = fresh([ME]);
    // Theo was written to twice, and Rae once, more lately, in a message Sent and Archive both hold.
    const toRae = sent(['rae@example.com'], { messageId: '<rae@trailmix.test>', date: hour(9) });
    const events = arrive(
      sent(['theo@example.com'], { date: hour(1) }),
      sent(['theo@example.com'], { date: hour(2) }),
      toRae,
      { ...toRae, path: 'Archive', uid: uid++ },
    );
    store.fold(events);
    store.fold(events);
    store.fold(arrive({ ...toRae, flags: { ...FLAGS, seen: true } }));
    expect(completed(store, 'example')).toEqual(['theo@example.com', 'rae@example.com']);
  });

  test('a message read again notes whom it names now', () => {
    const store = fresh([ME]);
    const ada = from('Ada', 'ada@example.com');
    store.fold(arrive(ada));
    store.fold(arrive({ ...ada, from: { name: 'Ada Park', email: 'ada@example.com' } }));
    expect(store.people('ada')).toEqual([{ name: 'Ada Park', email: 'ada@example.com' }]);
    store.fold(arrive({ ...ada, list: { id: 'parents.example.com' } }));
    expect(store.people('ada')).toEqual([]);
  });

  test('lets go of mail as it goes, moves to Junk, or goes unreported by a pass that reads its folder again', () => {
    const store = fresh([ME]);
    const ada = from('Ada Park', 'ada@example.com');
    const bo = from('Bo Lin', 'bo@example.com');
    const cy = from('Cy Moss', 'cy@example.com');
    const kept = from('Cy Moss', 'cy@example.com', { path: 'Archive' });
    store.fold(arrive(ada, bo, cy, kept));

    store.fold([{ type: 'gone', ref: ada }]);
    store.fold([{ type: 'gone', ref: bo }, ...arrive({ ...bo, path: 'Junk', uid: uid++ })]);
    // A pass over the Inbox that reports nothing, as sync folds one.
    store.noteReread('personal', 'INBOX', [], true);
    store.fold(
      store.endReread('personal', 'INBOX').map((ref): SyncEvent => ({ type: 'gone', ref })),
    );

    expect(completed(store, 'example')).toEqual(['cy@example.com']);
    store.fold([{ type: 'gone', ref: kept }]);
    expect(completed(store, 'example')).toEqual([]);
  });

  test('a folder that becomes Junk takes its mail out once the people are filled again', () => {
    const store = fresh([ME]);
    store.fold(arrive(from('Ada Park', 'ada@example.com', { path: 'Projects' })));
    expect(completed(store, 'ada')).toEqual(['ada@example.com']);
    store.listFolders(
      'personal',
      [
        ...FOLDERS.filter((f) => f.account === 'personal' && f.path !== 'Projects'),
        { account: 'personal', path: 'Projects', role: 'junk' as const },
      ].map((f) => ({ ...f, name: f.path, unread: 0, total: 0 })),
    );
    fill(store);
    expect(completed(store, 'ada')).toEqual([]);
  });

  test('forgets an account’s people and its own address with it, leaving no word of them on disk', () => {
    const sql = testSql();
    const own = [ME, 'me@work.example'];
    const store = fresh(own, sql);
    store.fold(
      arrive(
        from('Zanzibar Quill', 'zq@example.com', { account: 'work' }),
        from('Ada Park', 'ada@example.com'),
      ),
    );
    // The account's address leaves the member's own as the account is removed.
    own.pop();
    store.forget('work');
    expect(completed(store, 'example')).toEqual(['ada@example.com']);
    const blocks = sql
      .all<{ block: Uint8Array }>(`SELECT block FROM people_search_data`)
      .map(({ block }) => new TextDecoder('latin1').decode(block))
      .join('');
    expect(blocks.toLowerCase()).not.toContain('zanzibar');
    const held = sql
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map(({ name }) => JSON.stringify(sql.all(`SELECT * FROM "${name}"`)))
      .join('');
    expect(held).not.toMatch(/zanzibar|zq@|work\.example/i);
  });

  test('an upgrade notes the mail held a batch at a time, picking up where a wake stopped', () => {
    const current = testSql();
    const now = fresh([ME], current);
    const theo = sent(['theo@example.com'], { date: hour(2) });
    now.fold(
      arrive(
        ...Array.from({ length: 5 }, (_, i) =>
          from('Ada Park', 'ada@example.com', { date: hour(i) }),
        ),
        theo,
        sent(['rae@example.com'], { date: hour(3) }),
        from('Bo Lin', 'bo@example.com', { date: hour(9) }),
      ),
    );
    const sql = heldAsOf(20, current);
    upgrade(sql);
    const store = envelopeIndex(sql, () => [ME]);
    expect(completed(store, 'example')).toEqual([]);
    expect(store.fillPeople(3)).toBe(true);
    // Mail that folds meanwhile, again or anew, is noted once.
    store.fold(arrive(theo));
    // A new instance after an eviction reads the cursor from storage.
    fill(envelopeIndex(sql, () => [ME]));
    expect(store.people('example')).toEqual(now.people('example'));
    expect(store.fillPeople(3)).toBe(false);
  });

  test('a new Mailroom notes mail as it folds it, and owes no fill', () => {
    const store = fresh([ME]);
    store.fold(arrive(from('Ada Park', 'ada@example.com')));
    expect(store.fillPeople(1)).toBe(false);
    expect(completed(store, 'ada')).toEqual(['ada@example.com']);
  });

  test('an address that becomes the member’s notes every message again as theirs', () => {
    const own = [ME];
    const store = fresh(own);
    // The member wrote from an address Trail Mix didn't know was theirs yet.
    store.fold(arrive(sent(['rae@example.com'], { from: { email: 'me@work.test' } })));
    expect(completed(store, 'example')).toEqual([]);
    expect(completed(store, 'work')).toEqual(['me@work.test']);
    own.push('me@work.test');
    expect(completed(store, 'work')).toEqual([]);
    fill(store);
    expect(completed(store, 'example')).toEqual(['rae@example.com']);
  });

  test('the people the fold keeps are those a fill from the same mail counts, for any run of events', () => {
    const people = ['ada@example.com', 'bo@example.com', 'cy@example.org', 'noreply@example.com'];
    for (let seed = 1; seed <= 30; seed++) {
      let state = seed;
      const random = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
      const held: Envelope[] = [];
      const events: SyncEvent[] = [];
      for (let i = 0; i < 80; i++) {
        const roll = random();
        const folder = pick(FOLDERS);
        if (roll < 0.55 || held.length === 0) {
          const isMine = random() < 0.4;
          const message = envelope(`p${seed}-${i}`, {
            account: folder.account,
            path: folder.path,
            // Some messages are copies of one another, as Sent and Archive hold.
            messageId: `<p${seed}-${Math.floor(random() * 40)}@example.com>`,
            from: isMine
              ? { email: ME }
              : { name: random() < 0.5 ? 'Someone' : '', email: pick(people) },
            to: isMine ? [{ email: pick(people) }, { email: pick(people) }] : [{ email: ME }],
            date: new Date(Date.UTC(2026, 10, 1) + Math.floor(random() * 1e9)).toISOString(),
            ...(random() < 0.1 ? { list: { id: 'list.example.com' } } : {}),
          });
          held.push(message);
          events.push(...arrive(message));
        } else if (roll < 0.7) {
          events.push(...arrive(pick(held)));
        } else if (roll < 0.95) {
          const message = held.splice(Math.floor(random() * held.length), 1)[0]!;
          events.push({ type: 'gone', ref: message });
        } else {
          events.push({ type: 'reset', folder: { account: folder.account, path: folder.path } });
          for (let j = held.length - 1; j >= 0; j--) {
            if (held[j]!.account === folder.account && held[j]!.path === folder.path) {
              held.splice(j, 1);
            }
          }
        }
      }
      const sql = testSql();
      const store = fresh([ME], sql);
      for (let i = 0; i < events.length; i += 1 + (seed % 5)) {
        store.fold(events.slice(i, i + 1 + (seed % 5)));
      }
      const folded = sql.all(
        `SELECT address, name, wrote, heard, latest FROM people ORDER BY address`,
      );
      const completions = store.people('example');
      for (const table of ['correspondence', 'people', 'people_search', 'people_fill'])
        sql.run(`DELETE FROM ${table}`);
      fill(store);
      expect(
        sql.all(`SELECT address, name, wrote, heard, latest FROM people ORDER BY address`),
      ).toEqual(folded);
      expect(store.people('example')).toEqual(completions);
    }
  });
});
