import type { Folder, Outgoing } from '../../mail/core/index.ts';
import type { ViewCounts } from './views.ts';

/**
 * What the unified views count across every account: unread mail in the Inboxes, the drafts, and
 * the messages waiting in the Outbox. Flagged counts nothing, since flagged mail stays until it's
 * dealt with. Neither of the others counts a message the server has accepted: `onTheirWay` is how
 * many drafts on their way the folders' counts still include, and a send the server accepted only
 * waits for its copy in Sent.
 */
export function viewCounts(
  folders: readonly Folder[],
  outbox: readonly Outgoing[],
  onTheirWay = 0,
): ViewCounts {
  const sum = (role: Folder['role'], count: (folder: Folder) => number) =>
    folders.filter((folder) => folder.role === role).reduce((total, f) => total + count(f), 0);
  return {
    inbox: sum('inbox', ({ unread }) => unread),
    drafts: Math.max(0, sum('drafts', ({ total }) => total) - onTheirWay),
    outbox: outbox.filter(({ state }) => state !== 'accepted').length,
  };
}
