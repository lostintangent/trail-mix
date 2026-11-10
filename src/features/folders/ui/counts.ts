import type { Folder, Outgoing } from '../../mail/core/index.ts';
import type { ViewCounts } from './Sidebar.tsx';

/**
 * What the unified views count across every account: unread mail in the Inboxes, the drafts, and
 * the messages waiting in the Outbox. Flagged counts nothing, since flagged mail stays until it's
 * dealt with.
 */
export function viewCounts(folders: readonly Folder[], outbox: readonly Outgoing[]): ViewCounts {
  const sum = (role: Folder['role'], count: (folder: Folder) => number) =>
    folders.filter((folder) => folder.role === role).reduce((total, f) => total + count(f), 0);
  return {
    inbox: sum('inbox', ({ unread }) => unread),
    drafts: sum('drafts', ({ total }) => total),
    outbox: outbox.length,
  };
}
