import { Archive, ExternalLink, Mail, MailOpen, Star, Trash2 } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import { folderName } from '../../folders/index.ts';
import type { Account, Folder } from '../../mail/core/index.ts';
import type { Action } from '../core/triage.ts';

/** The prefix of the commands that move mail to a folder, one for each folder it can go to. */
export const MOVE = 'conversation.move:';
const DELETE_SHORTCUTS = ['#', 'Delete', 'Backspace'] as const;

/**
 * What can be done to the open conversation or a selection, as commands: archive, delete, flag,
 * mark read or unread, and move to each folder of its accounts. The reader's bar, the phone's
 * island, the palette and the keys all run these.
 */
export function triageCommands({
  accounts,
  folders,
  isFlagged,
  isUnread,
  onTriage,
}: {
  /** The accounts whose mail is being triaged, whose folders it can move to. */
  accounts: readonly Account[];
  folders: readonly Folder[];
  isFlagged: boolean;
  isUnread: boolean;
  onTriage: (action: Action) => void;
}): Command[] {
  const group = 'Conversation';
  return [
    {
      id: 'conversation.archive',
      title: 'Archive',
      group,
      shortcut: 'E',
      icon: Archive,
      run: () => onTriage({ do: 'archive' }),
    },
    {
      id: 'conversation.delete',
      title: 'Delete',
      group,
      shortcut: DELETE_SHORTCUTS,
      icon: Trash2,
      run: () => onTriage({ do: 'delete' }),
    },
    {
      id: 'conversation.flag',
      title: isFlagged ? 'Unflag' : 'Flag',
      group,
      shortcut: 'S',
      icon: Star,
      isChecked: isFlagged,
      run: () => onTriage({ do: isFlagged ? 'unflag' : 'flag' }),
    },
    {
      id: 'conversation.read',
      title: 'Mark read',
      group,
      shortcut: 'Shift+I',
      icon: MailOpen,
      isEnabled: isUnread,
      run: () => onTriage({ do: 'read' }),
    },
    {
      id: 'conversation.unread',
      title: 'Mark unread',
      group,
      shortcut: 'Shift+U',
      icon: Mail,
      isEnabled: !isUnread,
      run: () => onTriage({ do: 'unread' }),
    },
    ...accounts.flatMap((account) =>
      folders
        .filter((folder) => folder.account === account.id && folder.role !== 'drafts')
        .map((folder) => ({
          id: `${MOVE}${folder.account}/${folder.path}`,
          title:
            accounts.length > 1
              ? `Move to ${account.name} ${folderName(folder)}`
              : `Move to ${folderName(folder)}`,
          group: 'Move to',
          run: () => onTriage({ do: 'move', to: { account: folder.account, path: folder.path } }),
        })),
    ),
  ];
}

/**
 * Opening what the member reads on GitHub, in a new tab: the thread open, or else the bundle's
 * repository. It can't run while neither is open.
 */
export function gitHubCommand(address: string | undefined): Command {
  return {
    id: 'github.open',
    title: 'Open on GitHub',
    group: 'Conversation',
    shortcut: 'O',
    icon: ExternalLink,
    isEnabled: address !== undefined,
    run: () => void (address && window.open(address, '_blank', 'noopener,noreferrer')),
  };
}
