import { expect, test } from 'bun:test';
import type { AccountId, Hint } from '../../mail/core/index.ts';
import { demoMailbox, demoServer, type MailProvider } from '../../providers/index.ts';
import { envelopeIndex } from './envelope-index.ts';
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
  const queue = syncQueue({
    sql,
    store,
    hint: (hint) => hints.push(hint),
    provider: (account) => Promise.resolve(wrap(servers[account as keyof typeof servers].provider)),
    window: () => WINDOW,
    settled: (account, error) => settled.push({ account, messages: messages(account), error }),
  });
  /** Everything a list or a conversation shows. */
  const snapshot = () => ({
    folders: store.folders(),
    conversations: sql.all(
      `SELECT id, summary, inbox, drafts, flagged FROM conversations ORDER BY id`,
    ),
    placements: sql.all(`SELECT * FROM placements ORDER BY account, path, conversation`),
  });
  return { sql, store, servers, queue, hints, settled, messages, snapshot };
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
