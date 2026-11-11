import { describe, expect, test } from 'bun:test';
import {
  applySyncEvent,
  memoryIndex,
  type Envelope,
  type FolderRole,
  type MemoryIndex,
  type SyncEvent,
} from '../../mail/core/index.ts';
import { envelopeIndex, type EnvelopeIndex } from './envelope-index.ts';
import { upgrade } from './schema.ts';
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

function fresh(own: readonly string[] = []): EnvelopeIndex {
  const store = envelopeIndex(testSql(), () => own);
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
    expect(store.page({ in: 'inbox' }).items[0]?.recipients).toEqual([
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
    const avatars = store
      .page({ in: 'folder', folder: { account: 'personal', path: 'Sent' } })
      .items.map(({ subject, avatar }) => [subject, avatar]);
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
    const sql = testSql(16);
    sql.run(
      `INSERT INTO accounts (id, position, account, connection) VALUES ('personal', 0, ?, '{}')`,
      JSON.stringify({ address: 'Me@TrailMix.test' }),
    );
    const store = envelopeIndex(sql, () => ['Me@TrailMix.test']);
    store.listFolders(
      'personal',
      FOLDERS.filter((f) => f.account === 'personal').map((f) => ({
        ...f,
        name: f.path,
        unread: 0,
        total: 0,
      })),
    );
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
    const rows = () =>
      sql
        .all<{ id: string; summary: string }>(`SELECT id, summary FROM conversations ORDER BY id`)
        .map(({ id, summary }) => [id, JSON.parse(summary) as Record<string, unknown>] as const);
    const folded = rows();
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
    expect(rows()).toEqual(folded);
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
      store.page(view).items.map((item) => item.subject);
    expect(subjects({ in: 'folder', folder: { account: 'personal', path: 'Projects' } })).toEqual([
      'project',
    ]);
    expect(subjects({ in: 'inbox' })).toEqual(['work']);
    expect(subjects({ in: 'drafts' })).toEqual(['draft']);
    expect(subjects({ in: 'flagged' })).toEqual(['work']);
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
    expect(rows[1]!.senders).toEqual(store.page({ in: 'inbox' }).items[0]!.senders);
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
