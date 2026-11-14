import type { ConversationId, View } from '../../mail/core/index.ts';
import type { Listed } from './pages.ts';

/**
 * Listing only unread mail, which a folder or the unified Inbox may do: the filter a member turns on
 * and off, and the list it shows ahead of the Mailroom's.
 */

/** Whether a view lists only its unread mail. */
export const listsUnreadOnly = (view: View): boolean => 'unread' in view && view.unread === true;

/**
 * The filter that lists only unread mail: whether it's on, and the view a press turns to. A folder or
 * the unified Inbox offers it while it has unread mail, or while it lists only that. A search offers
 * it for the view it began from, since the palette's field goes back there before it runs a command.
 */
export function unreadFilter(
  view: View,
  /** The view a search began from. */
  returnTo: View,
  /** A view's unread count, where it has one. */
  unreadIn: (view: View) => number | undefined,
): { isOn: boolean; turnsTo: View } | undefined {
  const listed = view.in === 'search' ? returnTo : view;
  if (listed.in !== 'folder' && listed.in !== 'inbox') return undefined;
  const isOn = listsUnreadOnly(listed);
  if (!isOn && (unreadIn(listed) ?? 0) === 0) return undefined;
  const unread = isOn ? {} : ({ unread: true } as const);
  return {
    isOn,
    turnsTo:
      listed.in === 'folder'
        ? { in: 'folder', folder: listed.folder, ...unread }
        : { in: 'inbox', ...unread },
  };
}

/**
 * A list of unread mail as it shows ahead of the Mailroom's: its unread rows, and the one `keep`
 * names whether or not it is, so a conversation read while it's open stays until the member leaves
 * it. Places not yet fetched stay as they are.
 */
export function unreadOnly<Row extends { id: ConversationId; unread: number }>(
  rows: Listed<Row>,
  keep: ConversationId | undefined,
): Listed<Row> {
  const shown = rows.filter((row) => !row || row.unread > 0 || row.id === keep);
  return shown.length === rows.length ? rows : shown;
}
