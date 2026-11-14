import type {
  Account,
  AccountId,
  Folder,
  FolderRef,
  FolderRole,
  Hint,
  Message,
  SyncEvent,
} from '../../mail/core/index.ts';
import type { MailProvider, SyncBatch, SyncWindow } from '../../providers/index.ts';
import type { EnvelopeIndex } from './envelope-index.ts';
import { report } from './report.ts';
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

/**
 * What sync works with. `settled` hears when an account's check finishes, or fails, `landed` hears
 * each batch of a folder as the index takes it, in the same transaction, and `wakeNow` has the next
 * wake come at once, for a change a watched Inbox reported.
 */
type Syncing = {
  sql: Sql;
  store: EnvelopeIndex;
  hint: (hint: Hint) => void;
  provider: (account: AccountId) => Promise<MailProvider>;
  window: (account: AccountId) => SyncWindow;
  settled: (account: AccountId, error?: unknown) => void;
  landed?: (folder: FolderRef, events: readonly SyncEvent[]) => void;
  wakeNow: () => void;
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

/** A folder a command renamed, from its path on the server to its new one. */
type Move = { account: AccountId; from: string; to: string };

/** A message moved, as a rename moves it: gone from its folder and at the same UID in `to`. */
function movedTo({ conversation: _conversation, ...envelope }: Message, to: string): SyncEvent[] {
  const { account, path, uidValidity, uid } = envelope;
  return [
    { type: 'gone', ref: { account, path, uidValidity, uid } },
    { type: 'message', envelope: { ...envelope, path: to } },
  ];
}

/** A folder a watcher or a command owes goes first: someone is waiting to see it. */
const OWED = -2;
const LIST = -1;

/**
 * In a check, the folders a member looks at first sync first, so the lists they see fill first.
 * Folders of one rank take turns a batch at a time, so the unified Inbox fills newest first from
 * every account at once.
 */
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
  /** Folders whose sync failed during an account's check, with why, so the check skips them. */
  const failed = new Map<AccountId, Map<string, unknown>>();
  /** Folders a command is renaming or renamed, whose messages move when a listing shows it. */
  let moves: Move[] = [];
  /** How to stop watching each account's Inbox, while a device is open. */
  const watchers = new Map<AccountId, () => void>();
  /** When every account was last owed a check. A cold start checks at its first wake. */
  let checkedAt = 0;

  function owe(job: Omit<Job, 'again' | 'changed' | 'cancelled'>) {
    place({ ...job, again: false, changed: false, cancelled: false });
  }

  /** Places a job last among those of its rank. */
  function place(job: Job) {
    const rest = jobs.filter((held) => held !== job);
    const at = rest.findIndex((held) => held.rank > job.rank);
    jobs = at < 0 ? [...rest, job] : [...rest.slice(0, at), job, ...rest.slice(at)];
  }

  function drop(job: Job) {
    jobs = jobs.filter((held) => held !== job);
  }

  const owes = (account: AccountId) => jobs.some((job) => job.account === account);

  /**
   * Records the folders the server lists with their counts, and forgets those it no longer has,
   * mail and all. A folder a command renamed shows as its old path gone and its new one listed, and
   * its messages move to the new path as the index holds them, with the old path's cursor, so the
   * new path's sync goes on from there rather than downloading them again. If the server gave the
   * folder a new UIDVALIDITY, that sync starts it over. Returns the folders, or nothing if the job
   * was cancelled meanwhile.
   */
  async function list(job: Job, provider: MailProvider): Promise<Folder[] | undefined> {
    const { account } = job;
    const folders = await provider.folders();
    if (job.cancelled) return undefined;
    const before = JSON.stringify(store.folders(account));
    const listed = new Set(folders.map(({ path }) => path));
    // A folder renamed again before a listing showed it follows each rename to the one listed.
    const renamedTo = (path: string, hops = moves.length): string | undefined => {
      const to = moves.findLast((move) => move.account === account && move.from === path)?.to;
      if (to === undefined || hops === 0) return undefined;
      return listed.has(to) ? to : renamedTo(to, hops - 1);
    };
    const gone = sql.transaction(() =>
      store.listFolders(account, folders).flatMap((path) => {
        for (const held of jobs) {
          if (held.account === account && held.path === path) held.cancelled = true;
        }
        const to = renamedTo(path);
        const changed = store.fold(
          to === undefined
            ? [{ type: 'reset', folder: { account, path } }]
            : store.reads.folder({ account, path }).flatMap((message) => movedTo(message, to)),
        );
        const cursor = to === undefined ? null : store.cursor(account, path);
        if (to !== undefined && cursor !== null) store.saveCursor(account, to, cursor);
        if (to !== undefined) store.carryReread(account, path, to);
        store.dropFolder(account, path);
        return changed;
      }),
    );
    // A rename not yet listed waits for a listing that shows it.
    moves = moves.filter((move) => move.account !== account || listed.has(move.from));
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
    const skip = failed.get(job.account);
    for (const folder of folders) {
      if (skip?.has(folder.path)) continue;
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
      const folders = store.isRereading(account, path)
        ? reread(account, path, batch)
        : store.fold(batch.events);
      store.saveCursor(account, path, batch.cursor);
      // In the same transaction, so what it notes of the batch lands with the cursor or not at all.
      syncing.landed?.({ account, path }, batch.events);
      return folders;
    });
    for (const folder of changed) hint({ changed: 'conversations', folder });
    job.changed ||= batch.events.length > 0;
    if (batch.more) {
      place(job);
      return;
    }
    if (job.again) {
      job.again = false;
      return;
    }
    drop(job);
    // The folder's counts are the server's, and changed with it.
    if (job.changed && job.recount) await list(job, provider);
  }

  /**
   * Folds a batch of a folder being read again. Its first batch starts the folder over, but what
   * the index holds stays, so no list empties: each message the pass reports folds in place, and
   * once the pass ends, what it didn't report goes, as a sync would have let it go.
   */
  function reread(account: AccountId, path: string, batch: SyncBatch): FolderRef[] {
    const startsOver = batch.events.some(({ type }) => type === 'reset');
    const events = batch.events.filter(({ type }) => type !== 'reset');
    const reported = events.flatMap((event) => (event.type === 'message' ? [event.envelope] : []));
    store.noteReread(account, path, reported, startsOver);
    const folded = store.fold(events);
    if (batch.more) return folded;
    const left = store.endReread(account, path);
    return [...folded, ...store.fold(left.map((ref): SyncEvent => ({ type: 'gone', ref })))];
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
      if (job.path === undefined) {
        // Without its folders, nothing of the account can sync until the next check.
        forget(job.account);
        syncing.settled(job.account, error);
        return;
      }
      // The folder may be gone, renamed or deleted since it was owed. A listing settles that,
      // and the rest of the account syncs meanwhile.
      drop(job);
      failed.set(
        job.account,
        (failed.get(job.account) ?? new Map<string, unknown>()).set(job.path, error),
      );
      check(job.account);
      return;
    } finally {
      flying = undefined;
    }
    if (job.cancelled || owes(job.account) || !checking.has(job.account)) return;
    checking.delete(job.account);
    // A failure counts only if its folder is still there.
    const still = new Set(store.folders(job.account).map(({ path }) => path));
    const failure = [...(failed.get(job.account) ?? [])].find(([path]) => still.has(path));
    failed.delete(job.account);
    syncing.settled(job.account, failure?.[1]);
  }

  /** Owes a check of an account: its folders, then each folder in turn, Inbox first. */
  function check(account: AccountId) {
    checking.add(account);
    // A listing under way may have heard from the server before what prompted this check.
    const listed = (job: Job) => job.account === account && job.path === undefined;
    if (!jobs.some((job) => listed(job) && job !== flying)) {
      owe({ account, rank: LIST, recount: false });
    }
  }

  /** Owes a folder's sync, as a watcher or a command does, ahead of any check. */
  function folder({ account, path }: FolderRef) {
    const held = jobs.find((job) => job.account === account && job.path === path);
    if (held) {
      held.again = true;
      held.recount = true;
      return;
    }
    owe({ account, path, rank: OWED, recount: true });
  }

  async function watchInbox(account: AccountId) {
    if (watchers.has(account)) return;
    const inbox = store.withRole(account, 'inbox');
    if (!inbox) return;
    const provider = await syncing.provider(account);
    if (watchers.has(account)) return;
    const at = { account, path: inbox.path };
    watchers.set(
      account,
      provider.watch(at.path, () => {
        folder(at);
        syncing.wakeNow();
      }),
    );
  }

  function unwatch(account: AccountId) {
    watchers.get(account)?.();
    watchers.delete(account);
  }

  /** Forgets everything owed for an account. A step of it under way lands nothing. */
  function forget(account: AccountId) {
    for (const job of jobs) if (job.account === account) job.cancelled = true;
    jobs = jobs.filter((job) => job.account !== account);
    checking.delete(account);
    failed.delete(account);
  }

  return {
    check,

    folder,

    forget,

    /**
     * Watches each account's Inbox while a device is open, owing its sync at each change the server
     * reports, and stops watching it when none is. An account that needs signing in isn't watched.
     */
    async watch(accounts: readonly Pick<Account, 'id' | 'status'>[], open: boolean) {
      for (const { id, status } of accounts) {
        if (open && status !== 'needs-sign-in') await watchInbox(id).catch(report);
        else unwatch(id);
      }
    },

    unwatch,

    /** Stops watching every Inbox, as when the last device closes. */
    unwatchAll() {
      for (const id of [...watchers.keys()]) unwatch(id);
    },

    /** Owes every account a check, as of `at`. */
    checkAll(accounts: readonly Pick<Account, 'id'>[], at = Date.now()) {
      checkedAt = at;
      for (const { id } of accounts) check(id);
    },

    /** When every account was last owed a check. */
    checkedAt: () => checkedAt,

    /**
     * Notes folders a command is about to rename, so the listing that shows the rename moves their
     * messages rather than forgetting them, whichever connection it answers on. Returns how to take
     * the note back, for a rename that failed. Held in memory: a Mailroom that restarts first
     * downloads them.
     */
    renaming(account: AccountId, renames: readonly { from: string; to: string }[]) {
      const noted = renames.map((rename) => ({ account, ...rename }));
      moves = [...moves, ...noted];
      return () => {
        moves = moves.filter((move) => !noted.includes(move));
      };
    },

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

const rankOf = ({ role }: Folder) => ORDER.indexOf(ORDER.includes(role) ? role : undefined);
