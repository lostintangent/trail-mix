import type { AccountId, Folder, FolderRef, FolderRole, Hint } from '../../mail/core/index.ts';
import type { MailProvider, SyncWindow } from '../../providers/index.ts';
import type { EnvelopeIndex } from './envelope-index.ts';
import type { Sql } from './schema.ts';

/**
 * Sync: what a provider reports, folded into the envelope index one batch at a time. Each batch
 * lands in one transaction with the cursor it reached, so a sync cut short anywhere resumes from
 * the last batch that landed, and replaying one changes nothing.
 */
export type Syncing = { sql: Sql; store: EnvelopeIndex; hint: (hint: Hint) => void };

/** The folders a member looks at first sync first, so the lists they see fill first. */
const ORDER: (FolderRole | undefined)[] = [
  'inbox',
  'sent',
  'drafts',
  'archive',
  undefined,
  'junk',
  'trash',
];

/** Syncs an account: its folders, then each folder in turn. */
export async function syncAccount(
  syncing: Syncing,
  account: AccountId,
  provider: MailProvider,
  window: SyncWindow,
) {
  for (const folder of await syncFolders(syncing, account, provider)) {
    await syncFolder(syncing, folder, provider, window);
  }
}

/**
 * Records the folders the server lists and forgets those it no longer has, mail and all. Returns
 * them in the order to sync them.
 */
export async function syncFolders(
  { sql, store, hint }: Syncing,
  account: AccountId,
  provider: MailProvider,
): Promise<Folder[]> {
  const folders = await provider.folders();
  const changed = sql.transaction(() =>
    store.listFolders(account, folders).flatMap((path) => {
      const gone = store.fold([{ type: 'reset', folder: { account, path } }]);
      store.dropFolder(account, path);
      return gone;
    }),
  );
  hint({ changed: 'folders', account });
  for (const folder of changed) hint({ changed: 'conversations', folder });
  return [...folders].sort((a, b) => rank(a) - rank(b));
}

/**
 * Syncs one folder from its cursor until the provider says nothing more remains. Returns whether
 * the server reported any change, since then the folder's counts have changed too.
 */
export async function syncFolder(
  { sql, store, hint }: Syncing,
  { account, path }: FolderRef,
  provider: MailProvider,
  window: SyncWindow,
): Promise<boolean> {
  let reported = false;
  for (;;) {
    const batch = await provider.sync(path, store.cursor(account, path), window);
    reported ||= batch.events.length > 0;
    const changed = sql.transaction(() => {
      const folders = store.fold(batch.events);
      store.saveCursor(account, path, batch.cursor);
      return folders;
    });
    for (const folder of changed) hint({ changed: 'conversations', folder });
    if (!batch.more) return reported;
    // A provider with nothing to wait on, as the demo is, would otherwise hold the Mailroom until
    // the whole folder is in. Between batches, queries answer and hints go out.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const rank = (folder: Folder) => {
  const position = ORDER.indexOf(folder.role);
  return position < 0 ? ORDER.indexOf(undefined) : position;
};
