import { createProblem, deleteProblem, inside, renameProblem } from '../../folders/core/index.ts';
import type { AccountId, FolderRef } from '../../mail/core/index.ts';
import type { MailProvider } from '../../providers/index.ts';
import type { AccountBook } from './accounts.ts';
import * as input from './input.ts';
import type { SyncQueue } from './sync.ts';

/**
 * The member's folder commands: create, rename and delete. Each judges a change by the server's own
 * listing, not the index's, which a change a moment ago may not have reached yet, and owes a check
 * of the account, whose listing records it.
 */
export type FolderCommands = ReturnType<typeof folderCommands>;

export function folderCommands(ports: {
  book: Pick<AccountBook, 'get'>;
  provider: (account: AccountId) => Promise<MailProvider>;
  sync: Pick<SyncQueue, 'check' | 'renamed' | 'heldAt'>;
  owe: (owing: () => void) => Promise<void>;
}) {
  const { sync } = ports;

  const own = (folder: FolderRef): FolderRef => {
    const checked = input.folderOf(folder);
    if (!ports.book.get(checked.account)) throw new Error('There is no such account.');
    return checked;
  };

  return {
    async create(folder: FolderRef): Promise<void> {
      const { account, path } = own(folder);
      const provider = await ports.provider(account);
      const problem = createProblem(path, await provider.folders());
      if (problem) throw new Error(problem);
      await provider.createFolder(path);
      await ports.owe(() => sync.check(account));
    },

    async rename(folder: FolderRef, to: string): Promise<void> {
      const { account, path } = own(folder);
      const renamed = input.folderOf({ account, path: to }).path;
      const provider = await ports.provider(account);
      const listed = await provider.folders();
      const current = listed.find((each) => each.path === path);
      if (!current) throw new Error('There is no such folder.');
      const problem = renameProblem(current, renamed, listed);
      if (problem) throw new Error(problem);
      if (renamed === path) return;
      await provider.renameFolder(path, renamed);
      // The folders inside go along, and so do the messages the index holds in them all, under
      // the paths it holds them at, which an earlier rename not yet listed may have changed.
      sync.renamed(
        account,
        [current, ...inside(current, listed)].map(({ path: at }) => ({
          from: sync.heldAt(account, at),
          to: `${renamed}${at.slice(path.length)}`,
        })),
      );
      await ports.owe(() => sync.check(account));
    },

    async remove(folder: FolderRef): Promise<void> {
      const { account, path } = own(folder);
      const provider = await ports.provider(account);
      const listed = await provider.folders();
      const current = listed.find((each) => each.path === path);
      // Gone already, as when another device deleted it first.
      if (!current) return;
      const problem = deleteProblem(current, listed);
      if (problem) throw new Error(problem);
      await provider.deleteFolder(path);
      await ports.owe(() => sync.check(account));
    },
  };
}
