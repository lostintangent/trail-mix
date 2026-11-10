import { FolderPlus, FolderX, Pencil } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import { folderName } from './name.ts';
import { UNIFIED_VIEWS } from './Sidebar.tsx';

/** Every view the sidebar offers, as a command to go to it: the unified views, then each folder. */
export function viewCommands(
  accounts: readonly Account[],
  folders: readonly Folder[],
  open: (view: View) => void,
): Command[] {
  const group = 'Go to';
  return [
    ...UNIFIED_VIEWS.map(({ in: unified, label, icon }) => ({
      id: `go.${unified}`,
      title: `Go to ${label}`,
      group,
      icon,
      run: () => open({ in: unified }),
    })),
    ...folders.map((folder) => {
      const account = accounts.find(({ id }) => id === folder.account);
      const { account: id, path } = folder;
      return {
        id: `go.folder:${id}/${path}`,
        title: `Go to ${account ? `${account.name} ` : ''}${folderName(folder)}`,
        group,
        run: () => open({ in: 'folder', folder: { account: id, path } }),
      };
    }),
  ];
}

/** A question about a folder the member is answering in a dialog. */
export type FolderQuestion =
  | { ask: 'create'; account: Account }
  | { ask: 'rename'; folder: Folder }
  | { ask: 'delete'; folder: Folder };

/**
 * Creating a folder in each account, and renaming or deleting the folder in view. A folder with a
 * role, such as Inbox, is the mail server's to keep, so only the member's own folders change.
 */
export function folderCommands({
  accounts,
  folders,
  view,
  ask,
}: {
  accounts: readonly Account[];
  folders: readonly Folder[];
  view: View;
  ask: (question: FolderQuestion) => void;
}): Command[] {
  const group = 'Folders';
  const inView =
    view.in === 'folder'
      ? folders.find(
          ({ account, path }) => account === view.folder.account && path === view.folder.path,
        )
      : undefined;
  const own = inView && !inView.role ? inView : undefined;
  return [
    ...accounts.map((account) => ({
      id: `folder.create:${account.id}`,
      title: `New folder in ${account.name}`,
      group,
      icon: FolderPlus,
      run: () => ask({ ask: 'create', account }),
    })),
    {
      id: 'folder.rename',
      title: own ? `Rename ${own.name}` : 'Rename folder',
      group,
      icon: Pencil,
      isEnabled: own !== undefined,
      run: () => own && ask({ ask: 'rename', folder: own }),
    },
    {
      id: 'folder.delete',
      title: own ? `Delete ${own.name}` : 'Delete folder',
      group,
      icon: FolderX,
      isEnabled: own !== undefined,
      run: () => own && ask({ ask: 'delete', folder: own }),
    },
  ];
}
