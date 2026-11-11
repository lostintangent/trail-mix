import type {
  AccountId,
  Folder,
  FolderRef,
  FolderRole,
  Hint,
  Message,
  SyncEvent,
} from '../../mail/core/index.ts';
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

/** A folder a command renamed, from its path to its new one. */
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
  /** Folders whose sync failed during an account's check, with why, so the check skips them. */
  const failed = new Map<AccountId, Map<string, unknown>>();
  /** Folders a command renamed, whose messages move when a listing shows the rename. */
  let moves: Move[] = [];

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
    const shown = new Map(
      moves
        .filter((move) => move.account === account && !listed.has(move.from) && listed.has(move.to))
        .map(({ from, to }) => [from, to]),
    );
    const gone = sql.transaction(() =>
      store.listFolders(account, folders).flatMap((path) => {
        for (const held of jobs) {
          if (held.account === account && held.path === path) held.cancelled = true;
        }
        const to = shown.get(path);
        const changed = store.fold(
          to === undefined
            ? [{ type: 'reset', folder: { account, path } }]
            : store.reads.folder({ account, path }).flatMap((message) => movedTo(message, to)),
        );
        const cursor = to === undefined ? null : store.cursor(account, path);
        if (to !== undefined && cursor !== null) store.saveCursor(account, to, cursor);
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

  /** Forgets everything owed for an account. A step of it under way lands nothing. */
  function forget(account: AccountId) {
    for (const job of jobs) if (job.account === account) job.cancelled = true;
    jobs = jobs.filter((job) => job.account !== account);
    checking.delete(account);
    failed.delete(account);
  }

  return {
    check,

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

    /**
     * Notes folders a command renamed, from where the index holds them, so the listing that shows
     * the rename moves their messages rather than forgetting them. A folder renamed again before
     * that listing moves once, to its latest name. Held in memory: a Mailroom that restarts first
     * downloads them.
     */
    renamed(account: AccountId, renames: readonly { from: string; to: string }[]) {
      const again = (move: Move) =>
        move.account === account && renames.some(({ from }) => from === move.from);
      moves = [
        ...moves.filter((move) => !again(move)),
        ...renames.map((rename) => ({ account, ...rename })),
      ];
    },

    /**
     * Where the index holds a folder the server now has at `path`: a path a command renamed it from,
     * until a listing shows the rename, or else `path` itself.
     */
    heldAt(account: AccountId, path: string): string {
      return moves.find((move) => move.account === account && move.to === path)?.from ?? path;
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

const rankOf = (folder: Folder) => {
  const position = ORDER.indexOf(folder.role);
  return position < 0 ? ORDER.indexOf(undefined) : position;
};
