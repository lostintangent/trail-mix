import { FolderPen, FolderPlus, FolderX } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import { canHoldFolders, isOwn } from '../core/names.ts';
import { folderName } from './name.ts';
import { folderIcon, UNIFIED_VIEWS } from './views.ts';

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
        icon: folderIcon(folder),
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
 * deleting the folder in view.
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
  const inView =
    view.in === 'folder'
      ? folders.find(
          ({ account, path }) => account === view.folder.account && path === view.folder.path,
        )
      : undefined;
  return [
    ...accounts.map((each) => ({
      id: `${CREATE}${each.id}`,
      title: `New folder in ${each.name}`,
      group: GROUP,
      icon: FolderPlus,
      run: () => edit({ do: 'create', account: each }),
    })),
    ...folderActions({ folder: inView, accounts, folders, edit, remove }),
  ];
}

/**
 * What can be done to one folder: a new folder inside it, renaming it and deleting it, each
 * disabled where it can't be done. Only the member's own folders change: one with a role, or
 * holding one, is the server's to keep. The folder in view's are in the registry, and every
 * folder's are in the menu on its row.
 */
export function folderActions({
  folder,
  accounts,
  folders,
  edit,
  remove,
}: {
  /** None where no folder is in view, which disables them all. */
  folder: Folder | undefined;
  accounts: readonly Account[];
  folders: readonly Folder[];
  edit: (edit: FolderEdit) => void;
  remove: (folder: Folder) => void;
}): Command[] {
  const account = folder && accounts.find(({ id }) => id === folder.account);
  const isMine =
    folder !== undefined &&
    isOwn(
      folder,
      folders.filter((each) => each.account === folder.account),
    );
  const name = folder ? folderName(folder) : 'folder';
  return [
    {
      id: 'folder.create',
      title: `New folder in ${name}`,
      group: GROUP,
      icon: FolderPlus,
      isEnabled: account !== undefined && folder !== undefined && canHoldFolders(folder),
      run: () => account && folder && edit({ do: 'create', account, parent: folder }),
    },
    {
      id: 'folder.rename',
      title: `Rename ${name}`,
      group: GROUP,
      icon: FolderPen,
      isEnabled: isMine,
      run: () => folder && isMine && edit({ do: 'rename', folder }),
    },
    {
      id: 'folder.delete',
      title: `Delete ${name}`,
      group: GROUP,
      icon: FolderX,
      isDestructive: true,
      isEnabled: isMine,
      run: () => folder && isMine && remove(folder),
    },
  ];
}

const GROUP = 'Folders';
