import { FolderPen, FolderPlus, FolderX } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import { canHoldFolders, isOwn } from '../core/names.ts';
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

/**
 * A folder being named in place in the sidebar: a new one, at the top of an account or inside a
 * folder, or one being renamed.
 */
export type FolderEdit =
  { do: 'create'; account: Account; parent?: Folder } | { do: 'rename'; folder: Folder };

/** The prefix of the commands that make a folder at the top of an account, one for each. */
export const CREATE = 'folder.create:';

/**
 * Making a folder at the top of each account or inside the folder in view, and renaming or
 * deleting the folder in view. Only the member's own folders change: one with a role, or holding
 * one, is the server's to keep.
 */
export function folderCommands({
  accounts,
  folders,
  view,
  edit,
  remove,
}: {
  accounts: readonly Account[];
  folders: readonly Folder[];
  view: View;
  edit: (edit: FolderEdit) => void;
  /** Asks before deleting a folder, since a delete can't be undone. */
  remove: (folder: Folder) => void;
}): Command[] {
  const group = 'Folders';
  const inView =
    view.in === 'folder'
      ? folders.find(
          ({ account, path }) => account === view.folder.account && path === view.folder.path,
        )
      : undefined;
  const account = inView && accounts.find(({ id }) => id === inView.account);
  const isMine =
    inView !== undefined &&
    isOwn(
      inView,
      folders.filter((folder) => folder.account === inView.account),
    );
  const name = inView ? folderName(inView) : 'folder';
  return [
    ...accounts.map((each) => ({
      id: `${CREATE}${each.id}`,
      title: `New folder in ${each.name}`,
      group,
      icon: FolderPlus,
      run: () => edit({ do: 'create', account: each }),
    })),
    {
      id: 'folder.create',
      title: `New folder in ${name}`,
      group,
      icon: FolderPlus,
      isEnabled: account !== undefined && inView !== undefined && canHoldFolders(inView),
      run: () => account && inView && edit({ do: 'create', account, parent: inView }),
    },
    {
      id: 'folder.rename',
      title: `Rename ${name}`,
      group,
      icon: FolderPen,
      isEnabled: isMine,
      run: () => inView && isMine && edit({ do: 'rename', folder: inView }),
    },
    {
      id: 'folder.delete',
      title: `Delete ${name}`,
      group,
      icon: FolderX,
      isEnabled: isMine,
      run: () => inView && isMine && remove(inView),
    },
  ];
}
