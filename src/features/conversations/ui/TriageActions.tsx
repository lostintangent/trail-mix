import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import * as stylex from '@stylexjs/stylex';
import { Archive, Ellipsis, FolderInput, Star, Trash2 } from 'lucide-react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { folderName } from '../../folders/index.ts';
import type { Account, Folder } from '../../mail/core/index.ts';
import type { Action } from '../core/triage.ts';

/**
 * The triage controls, for the open conversation or a selection: archive, delete, move to a folder
 * of its account, flag, and mark read or unread. Each says what it does, and a flagged conversation's
 * star is marked with the highlighter. They sit in whatever toolbar holds them. Where room is short,
 * as in a phone's island, flagging joins marking read in the menu of more.
 */
export function TriageActions({
  accounts,
  folders,
  isFlagged,
  isUnread,
  isCompact = false,
  onTriage,
}: {
  /** The accounts whose mail is being triaged, whose folders it can move to. */
  accounts: readonly Account[];
  folders: readonly Folder[];
  isFlagged: boolean;
  isUnread: boolean;
  isCompact?: boolean;
  onTriage: (action: Action) => void;
}) {
  const flag = isFlagged ? 'Unflag' : 'Flag';
  const more: DropdownMenuOption[] = [
    ...(isCompact
      ? [{ label: flag, onClick: () => onTriage({ do: isFlagged ? 'unflag' : 'flag' }) }]
      : []),
    isUnread
      ? { label: 'Mark read', onClick: () => onTriage({ do: 'read' }) }
      : { label: 'Mark unread', onClick: () => onTriage({ do: 'unread' }) },
  ];
  return (
    <>
      <IconButton
        label="Archive"
        tooltip="Archive"
        icon={<Icon icon={Archive} />}
        variant="ghost"
        onClick={() => onTriage({ do: 'archive' })}
      />
      <IconButton
        label="Delete"
        tooltip="Delete"
        icon={<Icon icon={Trash2} />}
        variant="ghost"
        onClick={() => onTriage({ do: 'delete' })}
      />
      <DropdownMenu
        button={{
          label: 'Move to',
          tooltip: 'Move to',
          icon: <Icon icon={FolderInput} />,
          isIconOnly: true,
          variant: 'ghost',
        }}
        hasChevron={false}
        items={destinations(accounts, folders, onTriage)}
      />
      {isCompact ? null : (
        <IconButton
          label={flag}
          tooltip={flag}
          icon={<Icon icon={Star} xstyle={isFlagged && styles.flagged} />}
          variant="ghost"
          onClick={() => onTriage({ do: isFlagged ? 'unflag' : 'flag' })}
        />
      )}
      <DropdownMenu
        button={{
          label: 'More',
          tooltip: 'More',
          icon: <Icon icon={Ellipsis} />,
          isIconOnly: true,
          variant: 'ghost',
        }}
        hasChevron={false}
        items={more}
      />
    </>
  );
}

/** Where mail can move: each account's folders, under its name when there are several. */
function destinations(
  accounts: readonly Account[],
  folders: readonly Folder[],
  onTriage: (action: Action) => void,
): DropdownMenuOption[] {
  return accounts.map((account) => ({
    type: 'section',
    id: account.id,
    title: accounts.length > 1 ? account.name : undefined,
    items: folders
      .filter((folder) => folder.account === account.id && folder.role !== 'drafts')
      .map((folder) => ({
        id: folder.path,
        label: folderName(folder),
        onClick: () => onTriage({ do: 'move', to: { account: folder.account, path: folder.path } }),
      })),
  }));
}

const styles = stylex.create({
  flagged: {
    color: tm.highlight,
    fill: tm.highlight,
  },
});
