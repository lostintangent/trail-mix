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

function fresh(): EnvelopeIndex {
  const store = envelopeIndex(testSql());
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
    let after: string | undefined;
    do {
      const page = store.page({ in: 'inbox' }, after, 5);
      seen.push(...page.items.map((item) => `${item.date} ${item.id}`));
      after = page.next;
    } while (after);
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
