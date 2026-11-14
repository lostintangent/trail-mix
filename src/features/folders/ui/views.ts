import {
  Archive,
  ArchiveX,
  ClockArrowUp,
  File,
  Folder as FolderIcon,
  Inbox,
  Search,
  Send,
  Star,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  folderAt,
  type Account,
  type Folder,
  type FolderRole,
  type View,
} from '../../mail/core/index.ts';
import { folderName } from './name.ts';

/**
 * The views the sidebar offers, the title and count each shows at the head of the list, and the one
 * icon each shows wherever it is named: in the sidebar, on its rail, at the head of the list and in
 * the palette.
 */

type UnifiedView = Exclude<View['in'], 'folder' | 'search'>;

/** What each unified view counts: unread mail in Inbox, drafts, and messages waiting to leave. */
export type ViewCounts = Partial<Record<UnifiedView, number>>;

/** The views that gather mail across every account. */
export const UNIFIED_VIEWS = [
  { in: 'inbox', label: 'Inbox', icon: Inbox },
  { in: 'flagged', label: 'Flagged', icon: Star },
  { in: 'drafts', label: 'Drafts', icon: File },
  { in: 'outbox', label: 'Outbox', icon: ClockArrowUp },
] as const satisfies readonly { in: UnifiedView; label: string; icon: LucideIcon }[];

const unifiedOf = (view: View) => UNIFIED_VIEWS.find((unified) => unified.in === view.in);

/** A folder with a role shows the role's icon, the unified view's where there is one. */
const ROLE_ICONS: Record<FolderRole, LucideIcon> = {
  inbox: Inbox,
  drafts: File,
  sent: Send,
  archive: Archive,
  junk: ArchiveX,
  trash: Trash2,
};

/** A folder's icon: its role's, or a folder's. */
export const folderIcon = ({ role }: Folder): LucideIcon => (role ? ROLE_ICONS[role] : FolderIcon);

/** A view's icon: the unified view's, its folder's, or a search's. */
export function viewIcon(view: View, folders: readonly Folder[]): LucideIcon {
  switch (view.in) {
    case 'folder': {
      const folder = folderAt(folders, view.folder);
      return folder ? folderIcon(folder) : FolderIcon;
    }
    case 'search':
      return Search;
    default:
      return unifiedOf(view)?.icon ?? Inbox;
  }
}

/**
 * A view's title, the unread count its header shows (Inbox's across accounts, or a folder's), and
 * the one account it holds, if it holds only one.
 */
export function describeView(
  view: View,
  accounts: readonly Account[],
  folders: readonly Folder[],
  counts: ViewCounts,
): { title: string; unread?: number; scope?: Account } {
  switch (view.in) {
    case 'folder': {
      const folder = folderAt(folders, view.folder);
      return {
        title: folder ? folderName(folder) : view.folder.path,
        unread: folder?.unread,
        scope: accounts.find(({ id }) => id === view.folder.account),
      };
    }
    case 'search':
      return { title: 'Search' };
    default:
      return {
        title: unifiedOf(view)?.label ?? '',
        unread: view.in === 'inbox' ? counts.inbox : undefined,
      };
  }
}
