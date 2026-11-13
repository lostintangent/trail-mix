import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isBundle,
  type Account,
  type ConversationSummary,
  type Hint,
  type View,
} from '../../src/features/mail/core/index.ts';
import { PAGE_SIZE, type Page } from '../../src/features/mailroom/client/contract.ts';
import { caFile, ports, running, start, stop } from '../mail-server/server.ts';
import { startWorker, type LocalWorker } from '../workerd.ts';
import { percentile, type BenchArea, type Measurement } from './budget.ts';
import {
  BENCH_INBOX,
  LONG_THREAD,
  LONG_THREAD_SUBJECT,
  benchUser,
  seedBenchMailbox,
} from './mailroom/seed.ts';

/**
 * The Mailroom's budgets, as AGENTS.md sets them: the first sync of a 50,000-message folder from the
 * test mail server, with no batch over a second of CPU, and then a page of the unified Inbox, a
 * 50-message conversation and search as it is typed, read from that index.
 *
 * The sync is the real one, on workerd, provider, fold and SQLite included. A device is open while
 * it runs, and the Mailroom hints that device once for each Inbox batch it folds. The CPU workerd
 * spends between two hints is one batch's: parsing what the server sent, folding it and writing it.
 * Waiting on the mail server, and any pause between batches, costs no CPU, so neither counts.
 */
const BUDGET = {
  firstSync: 120_000,
  batch: 1_000,
  inboxPage: 10,
  pageAnywhere: 10,
  conversation: 10,
  search: 100,
};

/**
 * What a member types into search, a keystroke at a time: a sender's name, a newsletter's, and a
 * word nearly every message holds, which makes the first keystrokes the broadest searches.
 */
const TYPED = ['mina okafor', 'kernel weekly', 'are'].flatMap((text) =>
  Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1)).filter(
    (t) => !t.endsWith(' '),
  ),
);

/** How many times each typed search is asked. */
const SEARCHES = 10;

/** How many times each read is asked, for its 95th percentile. */
const READS = 200;

const INBOX = { in: 'inbox' } satisfies View;

export const mailroom: BenchArea = {
  name: 'mailroom',
  measure: async () => {
    // A server already running belongs to someone else, and is left as it is.
    const ours = running() === null;
    if (ours) await start('full');
    let worker: LocalWorker | undefined;
    try {
      await seedBenchMailbox();
      worker = await startWorker(
        {
          name: 'trail-mix-mailroom-bench',
          main: join(import.meta.dir, 'mailroom/worker.ts'),
          durable_objects: { bindings: [{ name: 'MAILROOM', class_name: 'BenchMailroom' }] },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['BenchMailroom'] }],
          r2_buckets: [{ binding: 'BODIES', bucket_name: 'bodies' }],
          vars: { CREDENTIALS_KEY: 'a-bench-key-that-is-at-least-32-characters' },
        },
        { env: { NODE_EXTRA_CA_CERTS: caFile } },
      );
      const sync = await firstSync(worker);
      const reads = await readTimes(worker.url);
      return [
        measured('First sync of a 50,000-message folder', sync.total, BUDGET.firstSync),
        measured('Slowest batch of that sync, CPU', sync.slowest, BUDGET.batch),
        measured('A page of the unified Inbox, p95', reads.page, BUDGET.inboxPage),
        measured(
          `The unified Inbox's last page, at ${reads.inboxLast.at}, p95`,
          reads.inboxLast.time,
          BUDGET.pageAnywhere,
        ),
        measured(
          `The Inbox folder's last page, at ${reads.folderLast.at}, p95`,
          reads.folderLast.time,
          BUDGET.pageAnywhere,
        ),
        measured('A 50-message conversation, p95', reads.conversation, BUDGET.conversation),
        measured('Search as it is typed, p95', reads.search, BUDGET.search),
      ];
    } finally {
      worker?.stop();
      if (ours) await stop();
    }
  },
};

/** Adds the bench's account with a device open, and times its first sync and every Inbox batch. */
async function firstSync({ url, group }: LocalWorker) {
  const workerd = processesIn(group, 'workerd');
  // workerd's CPU when the account's folders were listed, which is when its Inbox starts to sync,
  // and when each Inbox batch landed.
  let listed: number | undefined;
  let firstRows: number | undefined;
  const inboxBatches: number[] = [];
  const device = new WebSocket(`${url.replace(/^http/, 'ws')}/bench/updates`);
  device.addEventListener('message', (event) => {
    const hint = JSON.parse(String(event.data)) as Hint;
    if (hint.changed === 'folders') listed ??= cpuOf(workerd);
    if (hint.changed === 'conversations' && hint.folder.path === 'INBOX') {
      inboxBatches.push(cpuOf(workerd));
      firstRows ??= performance.now();
    }
  });
  await new Promise((opened, failed) => {
    device.addEventListener('open', opened);
    device.addEventListener('error', failed);
  });

  try {
    await call(url, 'addAccount', {
      provider: 'imap',
      name: 'Bench',
      address: benchUser.email,
      imap: { host: 'localhost', port: ports.imaps, secure: true },
      smtp: { host: 'localhost', port: ports.submissions, secure: true },
      password: benchUser.password,
    });
    const added = performance.now();
    const deadline = added + BUDGET.firstSync * 2;
    while ((await call<Account[]>(url, 'accounts'))[0]?.status !== 'ready') {
      if (performance.now() > deadline) throw new Error('The first sync did not finish.');
      await Bun.sleep(200);
    }
    const total = performance.now() - added;
    console.log(
      `The first Inbox rows landed ${Math.round(firstRows! - added)} ms after the account was added,` +
        ` and the whole Inbox in ${(total / 1000).toFixed(1)} s.`,
    );
    const expected = Math.ceil(BENCH_INBOX / 500);
    if (inboxBatches.length < expected || listed === undefined) {
      throw new Error(`Saw ${inboxBatches.length} Inbox batches, expected ${expected} at least.`);
    }
    // The first batch counts from the folder list, so connecting and signing in are not in it.
    const batches = inboxBatches.map((cpu, i) => cpu - (inboxBatches[i - 1] ?? listed!));
    const slowest = Math.max(...batches);
    console.log(
      `Inbox batches, CPU: p50 ${percentile(batches, 0.5)} ms, p95 ${percentile(batches, 0.95)} ms,` +
        ` max ${slowest} ms in batch ${batches.indexOf(slowest) + 1} of ${batches.length}.` +
        ` By tenths: ${tenths(batches).join(', ')} ms.`,
    );
    return { total, slowest };
  } finally {
    device.close();
  }
}

/** The mean of each tenth of a sync's batches, in order, which shows whether batches slow as the index grows. */
function tenths(batches: readonly number[]): number[] {
  return Array.from({ length: 10 }, (_, tenth) => {
    const slice = batches.slice(
      Math.floor((tenth * batches.length) / 10),
      Math.floor(((tenth + 1) * batches.length) / 10),
    );
    return Math.round(slice.reduce((sum, cpu) => sum + cpu, 0) / slice.length);
  });
}

/** Times the two reads where the Mailroom runs them, once the index holds the whole Inbox. */
async function readTimes(url: string) {
  const thread = await longThread(url);
  const messages = await call<unknown[]>(url, 'conversation', thread.id);
  if (messages.length !== LONG_THREAD) {
    throw new Error(`The long conversation holds ${messages.length} messages.`);
  }
  const page = await call<number[]>(url, 'timed', 'conversations', [INBOX], READS);
  // A page anywhere reads as quickly as the first, even the last, which passes over the most rows,
  // in a unified view and in a folder, whose placements it joins to its conversations.
  const lastPage = async (view: View) => {
    const { total } = await call<Page>(url, 'conversations', view);
    const at = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
    const times = await call<number[]>(url, 'timed', 'conversations', [view, at], READS);
    return { at, time: percentile(times, 0.95) };
  };
  const [account] = await call<Account[]>(url, 'accounts');
  const inboxLast = await lastPage(INBOX);
  const folderLast = await lastPage({
    in: 'folder',
    folder: { account: account!.id, path: 'INBOX' },
  });
  const conversation = await call<number[]>(url, 'timed', 'conversation', [thread.id], READS);
  const search: number[] = [];
  for (const text of TYPED) {
    search.push(
      ...(await call<number[]>(url, 'timed', 'conversations', [{ in: 'search', text }], SEARCHES)),
    );
  }
  return {
    page: percentile(page, 0.95),
    inboxLast,
    folderLast,
    conversation: percentile(conversation, 0.95),
    search: percentile(search, 0.95),
  };
}

/** The 50-message conversation, found by its subject in the unified Inbox, newest first. */
async function longThread(url: string): Promise<ConversationSummary> {
  for (let at = 0, pages = 0; pages < 100; pages++) {
    const page = await call<Page>(url, 'conversations', INBOX, at);
    const found = page.items.find(
      (item): item is ConversationSummary =>
        !isBundle(item) && item.subject.endsWith(LONG_THREAD_SUBJECT),
    );
    if (found) return found;
    at += page.items.length;
    if (page.items.length === 0 || at >= page.total) break;
  }
  throw new Error('The 50-message conversation is not in the unified Inbox.');
}

/**
 * The processes in a process group whose command is `name`. Wrangler runs two workerd processes,
 * one that runs the Worker and one in front of it that passes requests on.
 */
function processesIn(group: number, name: string): number[] {
  const listed = Bun.spawnSync(['ps', '-A', '-o', 'pid=,pgid=,comm=']).stdout.toString();
  const pids = listed.split('\n').flatMap((line) => {
    const [pid, pgid, command] = line.trim().split(/\s+/);
    return Number(pgid) === group && command?.endsWith(name) ? [Number(pid)] : [];
  });
  if (pids.length === 0) throw new Error(`No ${name} process in group ${group}.`);
  return pids;
}

/** How much CPU some processes have spent between them, in milliseconds, to the hundredth. */
function cpuOf(pids: readonly number[]): number {
  if (process.platform === 'linux') {
    // utime and stime, in clock ticks of a hundredth of a second, after the command's parentheses.
    return pids.reduce((total, pid) => {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
      return total + (Number(fields[11]) + Number(fields[12])) * 10;
    }, 0);
  }
  const listed = Bun.spawnSync(['ps', '-o', 'cputime=', '-p', pids.join(',')]).stdout.toString();
  const seconds = (time: string) =>
    time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return listed
    .trim()
    .split('\n')
    .reduce((total, time) => total + seconds(time.trim()) * 1000, 0);
}

/** Calls the bench member's Mailroom, as the test worker lets a bench do. */
async function call<T = unknown>(url: string, name: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`${url}/bench/call`, {
    method: 'POST',
    body: JSON.stringify({ name, args }),
  });
  const result = await response.json<{ value?: T; error?: string }>();
  if (result.error !== undefined) throw new Error(`${name}: ${result.error}`);
  return result.value as T;
}

function measured(name: string, value: number, budget: number): Measurement {
  return { area: 'mailroom', name, value, budget, unit: 'ms' };
}
