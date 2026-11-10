import type { AccountId, Folder, FolderRef, FolderRole, Hint } from '../../mail/core/index.ts';
import type { MailProvider, SyncWindow } from '../../providers/index.ts';
import type { EnvelopeIndex } from './envelope-index.ts';
import type { Sql } from './schema.ts';

/**
 * Sync: what each provider reports, folded into the envelope index one step at a time. A step
 * lists an account's folders, or lands one bounded batch of a folder in one transaction with the
 * cursor it reached, so sync cut short anywhere resumes from the last step that landed, and
 * replaying one changes nothing.
 *
 * Sync is owed, then landed in wakes. Each wake lands at most `WAKE.steps` steps and starts none
 * after `WAKE.ms`, so no one invocation of the Mailroom spends more than a few seconds of CPU
 * however large the mailbox. Steps count as well as time, because on Cloudflare the clock stands
 * still while code runs, and a provider that waits on nothing, as the demo's doesn't, would never
 * see it move.
 */
export const WAKE = { steps: 15, ms: 5_000 };

export type Budget = { steps: number; ms: number };

export type SyncQueue = ReturnType<typeof syncQueue>;

/** What sync works with. `settled` hears when an account's check finishes, or fails. */
export type Syncing = {
  sql: Sql;
  store: EnvelopeIndex;
  hint: (hint: Hint) => void;
  provider: (account: AccountId) => Promise<MailProvider>;
  window: (account: AccountId) => SyncWindow;
  settled: (account: AccountId, error?: unknown) => void;
};

/** One thing owed: an account's folders to list, or a folder to sync. */
type Job = {
  account: AccountId;
  /** The folder to sync. Without one, the job lists the account's folders. */
  path?: string;
  /** Jobs run lowest first, and in the order they were owed within a rank. */
  rank: number;
  /** Whether to count the account's folders again once this folder's sync reports a change. */
  recount: boolean;
  /** Whether the folder changed again while it synced, so it syncs once more. */
  again: boolean;
  /** Whether the server reported any change in this folder's sync so far. */
  changed: boolean;
  /** Set when the account goes, so a step under way lands nothing. */
  cancelled: boolean;
};

/** A folder a watcher or a command owes goes first: someone is waiting to see it. */
const OWED = -2;
const LIST = -1;

/** In a check, the folders a member looks at first sync first, so the lists they see fill first. */
const ORDER: (FolderRole | undefined)[] = [
  'inbox',
  'sent',
  'drafts',
  'archive',
  undefined,
  'junk',
  'trash',
];

export function syncQueue(syncing: Syncing) {
  const { sql, store, hint } = syncing;
  let jobs: Job[] = [];
  /** Accounts whose check is under way. Each is settled once it owes nothing more. */
  const checking = new Set<AccountId>();
  let running = false;
  /** The job whose step is under way. It stays owed until its step finishes it. */
  let flying: Job | undefined;

  function owe(job: Omit<Job, 'again' | 'changed' | 'cancelled'>) {
    const at = jobs.findIndex((held) => held.rank > job.rank);
    const added = { ...job, again: false, changed: false, cancelled: false };
    jobs = at < 0 ? [...jobs, added] : [...jobs.slice(0, at), added, ...jobs.slice(at)];
  }

  function drop(job: Job) {
    jobs = jobs.filter((held) => held !== job);
  }

  const owes = (account: AccountId) => jobs.some((job) => job.account === account);

  /**
   * Records the folders the server lists with their counts, and forgets those it no longer has,
   * mail and all. Returns them, or nothing if the job was cancelled meanwhile.
   */
  async function list(job: Job, provider: MailProvider): Promise<Folder[] | undefined> {
    const { account } = job;
    const folders = await provider.folders();
    if (job.cancelled) return undefined;
    const before = JSON.stringify(store.folders(account));
    const gone = sql.transaction(() =>
      store.listFolders(account, folders).flatMap((path) => {
        for (const held of jobs) {
          if (held.account === account && held.path === path) held.cancelled = true;
        }
        const changed = store.fold([{ type: 'reset', folder: { account, path } }]);
        store.dropFolder(account, path);
        return changed;
      }),
    );
    jobs = jobs.filter((held) => !held.cancelled);
    // A hint means something changed: the folders, their names or their counts.
    if (JSON.stringify(store.folders(account)) !== before) hint({ changed: 'folders', account });
    for (const folder of gone) hint({ changed: 'conversations', folder });
    return folders;
  }

  /** A check's first step: the folders, then each folder owed in turn. */
  async function listing(job: Job, provider: MailProvider) {
    const folders = await list(job, provider);
    if (!folders) return;
    drop(job);
    for (const folder of folders) {
      if (jobs.some((held) => held.account === job.account && held.path === folder.path)) continue;
      owe({ account: job.account, path: folder.path, rank: rankOf(folder), recount: false });
    }
  }

  /** Lands one batch of a folder, and finishes the folder once nothing more remains. */
  async function batch(job: Job, path: string, provider: MailProvider) {
    const { account } = job;
    const batch = await provider.sync(path, store.cursor(account, path), syncing.window(account));
    if (job.cancelled) return;
    const changed = sql.transaction(() => {
      const folders = store.fold(batch.events);
      store.saveCursor(account, path, batch.cursor);
      return folders;
    });
    for (const folder of changed) hint({ changed: 'conversations', folder });
    job.changed ||= batch.events.length > 0;
    if (batch.more) return;
    if (job.again) {
      job.again = false;
      return;
    }
    drop(job);
    // The folder's counts are the server's, and changed with it.
    if (job.changed && job.recount) await list(job, provider);
  }

  async function step(job: Job) {
    flying = job;
    try {
      const provider = await syncing.provider(job.account);
      if (job.cancelled) return;
      if (job.path === undefined) await listing(job, provider);
      else await batch(job, job.path, provider);
    } catch (error) {
      if (job.cancelled) return;
      forget(job.account);
      syncing.settled(job.account, error);
      return;
    } finally {
      flying = undefined;
    }
    if (job.cancelled || owes(job.account) || !checking.has(job.account)) return;
    checking.delete(job.account);
    syncing.settled(job.account);
  }

  /** Forgets everything owed for an account. A step of it under way lands nothing. */
  function forget(account: AccountId) {
    for (const job of jobs) if (job.account === account) job.cancelled = true;
    jobs = jobs.filter((job) => job.account !== account);
    checking.delete(account);
  }

  return {
    /** Owes a check of an account: its folders, then each folder in turn, Inbox first. */
    check(account: AccountId) {
      checking.add(account);
      // A listing under way may have heard from the server before what prompted this check.
      const listed = (job: Job) => job.account === account && job.path === undefined;
      if (!jobs.some((job) => listed(job) && job !== flying)) {
        owe({ account, rank: LIST, recount: false });
      }
    },

    /** Owes a folder's sync, as a watcher or a command does, ahead of any check. */
    folder({ account, path }: FolderRef) {
      const held = jobs.find((job) => job.account === account && job.path === path);
      if (held) {
        held.again = true;
        held.recount = true;
        return;
      }
      owe({ account, path, rank: OWED, recount: true });
    },

    forget,

    /** Whether anything is owed, so another wake should follow at once. */
    owing: () => jobs.length > 0,

    /** Lands what is owed, within the budget, and returns how many steps it landed. */
    async run(budget: Budget = WAKE): Promise<number> {
      if (running) return 0;
      running = true;
      const started = Date.now();
      let landed = 0;
      try {
        while (jobs.length > 0 && landed < budget.steps && Date.now() - started < budget.ms) {
          await step(jobs[0]!);
          landed++;
          // Between steps, queries answer and hints go out, even when the provider waits on nothing.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } finally {
        running = false;
      }
      return landed;
    },
  };
}

const rankOf = (folder: Folder) => {
  const position = ORDER.indexOf(folder.role);
  return position < 0 ? ORDER.indexOf(undefined) : position;
};
