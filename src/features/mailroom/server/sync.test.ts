import { expect, test } from 'bun:test';
import type { AccountId, Hint, SyncEvent } from '../../mail/core/index.ts';
import { demoMailbox, demoServer, type MailProvider } from '../../providers/index.ts';
import { envelopeIndex } from './envelope-index.ts';
import { REREAD } from './schema.ts';
import { syncQueue, type Budget } from './sync.ts';
import { testSql } from './test-sql.ts';

const AT = '2026-11-09T12:00:00.000Z';
const WINDOW = { since: '2025-11-09T12:00:00.000Z' };
const ALL: Budget = { steps: Infinity, ms: Infinity };

/** A Mailroom's index and sync queue over two demo servers, with what each check settled to. */
function mailroom(size: number, wrap = (provider: MailProvider) => provider) {
  const sql = testSql();
  const store = envelopeIndex(sql);
  const servers = {
    personal: demoServer('personal', demoMailbox('personal', size, AT), () => {}),
    work: demoServer('work', demoMailbox('work', Math.ceil(size / 10), AT), () => {}),
  };
  const messages = (account: AccountId) =>
    sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE account = ?`, account)[0]!.n;
  const hints: Hint[] = [];
  const settled: { account: AccountId; messages: number; error?: unknown }[] = [];
  const landed: { path: string; events: readonly SyncEvent[] }[] = [];
  const make = () =>
    syncQueue({
      sql,
      store,
      hint: (hint) => hints.push(hint),
      provider: (account) =>
        Promise.resolve(wrap(servers[account as keyof typeof servers].provider)),
      window: () => WINDOW,
      settled: (account, error) => settled.push({ account, messages: messages(account), error }),
      landed: ({ path }, events) => landed.push({ path, events }),
    });
  let queue = make();
  /** Everything a list or a conversation shows. */
  const snapshot = () => ({
    folders: store.folders(),
    conversations: sql.all(
      `SELECT id, summary, inbox, drafts, flagged FROM conversations ORDER BY id`,
    ),
    placements: sql.all(`SELECT * FROM placements ORDER BY account, path, conversation`),
  });
  return {
    sql,
    store,
    servers,
    get queue() {
      return queue;
    },
    /** A Mailroom that starts again, with only what storage holds. */
    restart() {
      queue = make();
    },
    hints,
    settled,
    landed,
    messages,
    snapshot,
  };
}

test('a first sync lands over several wakes within budget, and gives what one long wake would', async () => {
  const bounded = mailroom(600);
  bounded.queue.check('personal');
  bounded.queue.check('work');
  const wakes: number[] = [];
  while (bounded.queue.owing()) wakes.push(await bounded.queue.run({ steps: 3, ms: Infinity }));
  expect(wakes.length).toBeGreaterThan(3);
  expect(Math.max(...wakes)).toBeLessThanOrEqual(3);

  const whole = mailroom(600);
  whole.queue.check('personal');
  whole.queue.check('work');
  await whole.queue.run(ALL);
  expect(whole.queue.owing()).toBe(false);
  expect(bounded.snapshot()).toEqual(whole.snapshot());

  // Each account reads ready once, and only once all of its mail is in.
  expect(bounded.settled).toEqual([
    { account: 'personal', messages: bounded.messages('personal'), error: undefined },
    { account: 'work', messages: bounded.messages('work'), error: undefined },
  ]);
});

test('Inboxes take turns a batch at a time, so the unified Inbox’s first page lands first', async () => {
  const room = mailroom(600);
  room.queue.check('personal');
  room.queue.check('work');
  // Each account's folders, then each Inbox's newest batch.
  await room.queue.run({ steps: 4, ms: Infinity });
  const first = room.store.page({ in: 'inbox' }).items;
  await room.queue.run(ALL);
  const full = room.store.page({ in: 'inbox' }).items;
  // Rows move as Sent and Archive fill in, but the first page holds the conversations it will.
  const ids = (rows: typeof first) => rows.map(({ id }) => id).sort();
  expect(ids(first)).toEqual(ids(full));
  // The newest mail is both accounts'.
  expect(new Set(first.map(({ account }) => account))).toEqual(new Set(['personal', 'work']));
});

test('mail a watcher reports goes ahead of a first sync still under way', async () => {
  const room = mailroom(1200);
  room.queue.check('personal');
  const reached = (path: string) =>
    room.hints.some((hint) => hint.changed === 'conversations' && hint.folder.path === path);
  while (!reached('Sent')) await room.queue.run({ steps: 1, ms: Infinity });
  expect(room.queue.owing()).toBe(true);

  await room.servers.personal.deliver(new TextEncoder().encode(raw('Arrived mid-sync')));
  room.queue.folder({ account: 'personal', path: 'INBOX' });
  await room.queue.run({ steps: 1, ms: Infinity });
  const inbox = room.store.reads.folder({ account: 'personal', path: 'INBOX' });
  expect(inbox.map((message) => message.subject)).toContain('Arrived mid-sync');
});

test('a check that finds nothing new hints nothing, and new mail hints its folder and the counts', async () => {
  const room = mailroom(100);
  room.queue.check('personal');
  await room.queue.run(ALL);

  room.hints.length = 0;
  room.queue.check('personal');
  await room.queue.run(ALL);
  expect(room.hints).toEqual([]);

  await room.servers.personal.deliver(new TextEncoder().encode(raw('Arriving now')));
  room.queue.folder({ account: 'personal', path: 'INBOX' });
  await room.queue.run(ALL);
  expect(room.hints).toEqual([
    { changed: 'conversations', folder: { account: 'personal', path: 'INBOX' } },
    { changed: 'folders', account: 'personal' },
  ]);
});

test('a folder that goes while its sync is owed leaves the rest of the account to sync', async () => {
  const room = mailroom(100);
  const { provider } = room.servers.personal;
  await provider.createFolder('Receipts');
  room.queue.check('personal');
  await room.queue.run(ALL);
  room.settled.length = 0;

  // A move into the folder owed its sync, and then it was renamed, as a member can do in a breath.
  room.queue.folder({ account: 'personal', path: 'Receipts' });
  await provider.renameFolder('Receipts', 'Receipts 2026');
  room.queue.check('personal');
  await room.queue.run(ALL);

  expect(room.queue.owing()).toBe(false);
  const paths = room.store.folders('personal').map(({ path }) => path);
  expect(paths).toContain('Receipts 2026');
  expect(paths).not.toContain('Receipts');
  expect(room.settled).toEqual([
    { account: 'personal', messages: room.messages('personal'), error: undefined },
  ]);
});

test('a step under way when its account goes lands nothing', async () => {
  let release = () => {};
  let waiting = () => {};
  const asked = new Promise<void>((resolve) => (waiting = resolve));
  const room = mailroom(100, (provider) => ({
    ...provider,
    async sync(...args) {
      waiting();
      await new Promise<void>((resolve) => (release = resolve));
      return provider.sync(...args);
    },
  }));
  room.queue.check('personal');
  const running = room.queue.run(ALL);
  await asked;
  room.queue.forget('personal');
  room.store.forget('personal');
  release();
  await running;
  expect(room.messages('personal')).toBe(0);
  expect(room.store.folders('personal')).toEqual([]);
  expect(room.settled).toEqual([]);
});

/** A message from Ada, dated when the demo was made. */
function raw(subject: string) {
  return [
    'From: Ada Park <ada@example.com>',
    'To: sam@trailmix.test',
    `Subject: ${subject}`,
    `Date: ${new Date(AT).toUTCString()}`,
    `Message-ID: <${subject.toLowerCase().replaceAll(' ', '-')}@example.com>`,
    '',
    'Hello.',
    '',
  ].join('\r\n');
}

test('a re-read folds every message again in place, so no row goes or moves until the pass lets go of what the server no longer has', async () => {
  const room = mailroom(600);
  room.queue.check('personal');
  await room.queue.run(ALL);
  const inbox = { account: 'personal', path: 'INBOX' };
  const rows = () =>
    room.sql
      .all<{ conversation: string }>(
        `SELECT conversation FROM placements WHERE account = ? AND path = ?
          ORDER BY date DESC, conversation DESC`,
        inbox.account,
        inbox.path,
      )
      .map(({ conversation }) => conversation);
  const before = rows();
  // As an earlier release indexed them: with a preview read worse, and no sender verified.
  room.sql.run(
    `UPDATE messages SET message = json_set(json_remove(message, '$.verified'), '$.preview', 'stale')
      WHERE account = 'personal'`,
  );
  room.sql.run(
    `UPDATE search SET preview = 'stale' WHERE rowid IN (SELECT rowid FROM messages WHERE account = 'personal')`,
  );
  // The server lets go of the Inbox's oldest message, which the index still holds.
  const oldest = room.store.reads
    .folder(inbox)
    .toSorted((a, b) => a.date.localeCompare(b.date))[0]!;
  await room.servers.personal.expunge('INBOX', oldest.messageId);
  const after = before.filter((id) => id !== oldest.conversation);

  room.sql.run(REREAD);
  room.queue.check('personal');
  const seen: string[][] = [];
  for (let step = 0; room.queue.owing(); step++) {
    await room.queue.run({ steps: 1, ms: Infinity });
    seen.push(rows());
    // A Mailroom that starts again part way goes on with the pass.
    if (step === 3) {
      room.restart();
      room.queue.check('personal');
    }
  }
  const ended = seen.findIndex((shown) => shown.length === after.length);
  expect(ended).toBeGreaterThan(0);
  expect(seen.slice(0, ended).every((shown) => shown.join() === before.join())).toBe(true);
  expect(seen.slice(ended).every((shown) => shown.join() === after.join())).toBe(true);

  // It ends holding what a first sync of the same server holds, and searches as that does.
  const fresh = mailroom(600);
  await fresh.servers.personal.expunge('INBOX', oldest.messageId);
  fresh.queue.check('personal');
  await fresh.queue.run(ALL);
  expect(room.snapshot()).toEqual(fresh.snapshot());
  expect(room.sql.all(`SELECT rowid FROM search WHERE search MATCH 'stale'`)).toEqual([]);
  expect(room.sql.all(`SELECT * FROM reread`)).toEqual([]);
  // The batch that started the Inbox over is heard as one, so it brings no news.
  const startsOver = room.landed.filter(
    ({ path, events }) => path === 'INBOX' && events.some(({ type }) => type === 'reset'),
  );
  expect(startsOver).toHaveLength(2);
});

test('a folder its server numbers again part way through a re-read starts the pass over, and keeps nothing it numbered before', async () => {
  const room = mailroom(600);
  room.queue.check('personal');
  await room.queue.run(ALL);
  room.sql.run(REREAD);
  room.queue.folder({ account: 'personal', path: 'INBOX' });
  await room.queue.run({ steps: 1, ms: Infinity });
  expect(room.store.isRereading('personal', 'INBOX')).toBe(true);
  await room.servers.personal.resetUidValidity('INBOX');
  await room.queue.run(ALL);

  const fresh = mailroom(600);
  await fresh.servers.personal.resetUidValidity('INBOX');
  fresh.queue.check('personal');
  await fresh.queue.run(ALL);
  expect(room.snapshot()).toEqual(fresh.snapshot());
  expect(room.messages('personal')).toBe(fresh.messages('personal'));
});
