import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { FolderCog } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import { menuItems } from './ActionsMenu.tsx';

/** The commands a folder's menu lists, in order. */
const IDS = ['folder.create', 'folder.rename', 'folder.delete'];

/**
 * What can be done to the folder in view, beside the list title even when the sidebar is folded:
 * a new folder inside it,
 * renaming it, and deleting it, each drawn from its command and left out when it can't run.
 */
export function FolderMenu({ commands }: { commands: readonly Command[] }) {
  const items = menuItems(IDS.flatMap((id) => commands.find((command) => command.id === id) ?? []));
  if (items.length === 0) return null;
  return (
    <DropdownMenu
      button={{
        label: 'Folder',
        tooltip: 'Folder',
        icon: <Icon icon={FolderCog} />,
        isIconOnly: true,
        variant: 'ghost',
      }}
      hasChevron={false}
      items={items}
    />
  );
}
