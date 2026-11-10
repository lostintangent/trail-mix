// The bench's mailbox: an Inbox of 50,000 messages on the test mail server, for bench@trailmix.test.
// It is the demo's Personal Inbox, byte for byte, plus one conversation of 50 messages, the longest
// the budgets read. Loading it takes about half a minute, so it is kept between runs and loaded
// again only when what the demo says changes.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeMime } from '../../../src/features/mail/core/index.ts';
import { DEMO_ACCOUNTS, demoMailbox, demoServer } from '../../../src/features/providers/index.ts';
import { count, emptyFolder, homeOf, importInbox, users } from '../../mail-server/server.ts';

export const BENCH_INBOX = 50_000;
export const LONG_THREAD = 50;
export const { bench: benchUser } = users;
export const LONG_THREAD_SUBJECT = 'Review: the outbox state machine';

/** When the demo's mail was written, fixed so the mailbox is the same on every run. */
const CREATED = '2026-11-09T17:41:00.000Z';
const WINDOW = { since: '2025-11-09T17:41:00.000Z' };

/** Fills the bench user's Inbox unless it already holds this exact mailbox. Says whether it loaded. */
export async function seedBenchMailbox(): Promise<boolean> {
  const mbox = await benchMbox();
  const key = Bun.hash(mbox).toString(16);
  const home = homeOf(benchUser.email);
  const marker = join(home, 'bench-seed');
  const kept = existsSync(marker) && readFileSync(marker, 'utf8') === key;
  if (kept && (await count(benchUser.email, 'INBOX')) === BENCH_INBOX) return false;

  const scratch = join(home, 'seed');
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'inbox'), mbox);
  try {
    await emptyFolder(benchUser.email, 'INBOX');
    await importInbox(benchUser.email, join(scratch, 'inbox'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const loaded = await count(benchUser.email, 'INBOX');
  if (loaded !== BENCH_INBOX) throw new Error(`The bench's Inbox holds ${loaded} messages.`);
  writeFileSync(marker, key);
  return true;
}

/**
 * The Inbox as an mbox file, oldest first: the demo's Personal Inbox, 50 messages short, with a
 * conversation of 50 that has run all through the past week delivered into it.
 */
async function benchMbox(): Promise<string> {
  const server = demoServer(
    'bench',
    demoMailbox('personal', BENCH_INBOX - LONG_THREAD, CREATED),
    () => {},
  );
  for (const raw of longThread()) await server.deliver(new TextEncoder().encode(raw));

  const { provider } = server;
  const refs = [];
  for (let cursor: string | null = null; ;) {
    const batch = await provider.sync('INBOX', cursor, WINDOW);
    for (const event of batch.events) if (event.type === 'message') refs.push(event.envelope);
    cursor = batch.cursor;
    if (!batch.more) break;
  }
  const messages = await Promise.all(
    refs
      .sort((a, b) => a.uid - b.uid)
      .map(async (ref) => new Response(await provider.body(ref)).text()),
  );
  if (messages.length !== BENCH_INBOX)
    throw new Error(`The demo gave ${messages.length} messages.`);
  return messages.map(mboxEntry).join('');
}

/** One message as an mbox entry, its lines quoted where they could be read as the next entry. */
function mboxEntry(raw: string): string {
  const date = new Date(/^Date: (.*)$/m.exec(raw)?.[1] ?? CREATED);
  const asctime = date
    .toUTCString()
    .replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4');
  const body = raw.replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
  return `From MAILER-DAEMON ${asctime}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`;
}

/** A pull request's review that went on all week: 50 messages, each answering the one before. */
function longThread(): string[] {
  const people = [
    { name: 'Ada Park', email: 'ada@example.com' },
    { name: 'Theo Lindqvist', email: 'theo@example.com' },
    { name: 'Priya Raman', email: 'priya@example.com' },
  ];
  const id = (i: number) => `<bench-thread.${i}@example.com>`;
  return Array.from({ length: LONG_THREAD }, (_, i) =>
    writeMime({
      date: new Date(Date.parse(CREATED) - (LONG_THREAD - i) * 3 * 60 * 60_000).toISOString(),
      messageId: id(i),
      from: people[i % people.length]!,
      to: [DEMO_ACCOUNTS.personal.me],
      subject: i === 0 ? LONG_THREAD_SUBJECT : `Re: ${LONG_THREAD_SUBJECT}`,
      references: Array.from({ length: i }, (_, j) => id(j)),
      text: `Round ${i + 1} of the review. The retry path reads well now, and one question remains about the undo window.`,
      boundary: `bench.${i}`,
    }),
  );
}

if (import.meta.main) {
  const started = performance.now();
  const loaded = await seedBenchMailbox();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`${loaded ? 'Loaded' : 'Kept'} the bench's ${BENCH_INBOX} messages in ${seconds} s.`);
}
