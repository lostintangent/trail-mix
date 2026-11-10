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
