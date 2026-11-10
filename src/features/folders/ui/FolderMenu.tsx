import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { Ellipsis, FolderCog } from 'lucide-react';
import { isApple, shortcutLabel, type Command } from '../../commands/index.ts';

/** The commands a folder's menu lists, in order. */
const IDS = ['folder.create', 'folder.rename', 'folder.delete'];

/**
 * What can be done to the folder in view, as one menu: a new folder inside it, renaming it, and
 * deleting it, each drawn from its command and left out when it can't run. In the list's header it
 * reads as the folder's own menu, and beside its row in the sidebar as More.
 */
export function FolderMenu({
  commands,
  place,
}: {
  commands: readonly Command[];
  place: 'header' | 'row';
}) {
  const items: DropdownMenuOption[] = IDS.flatMap((id) => {
    const command = commands.find((each) => each.id === id);
    if (!command || command.isEnabled === false) return [];
    return [
      {
        id,
        label: command.title,
        icon: command.icon && <Icon icon={command.icon} />,
        ...(command.shortcut ? { endContent: shortcutLabel(command.shortcut, isApple) } : {}),
        ...(id === 'folder.delete' ? { variant: 'destructive' as const } : {}),
        onClick: () => void command.run(),
      },
    ];
  });
  if (items.length === 0) return null;
  const label = place === 'header' ? 'Folder' : 'More for this folder';
  return (
    <DropdownMenu
      button={{
        label,
        tooltip: label,
        icon: (
          <Icon
            icon={place === 'header' ? FolderCog : Ellipsis}
            size={place === 'row' ? 'sm' : undefined}
          />
        ),
        isIconOnly: true,
        variant: 'ghost',
        size: place === 'row' ? 'sm' : undefined,
      }}
      hasChevron={false}
      items={items}
    />
  );
}
