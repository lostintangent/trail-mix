import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { folderName } from '../../folders/index.ts';
import type { ConversationId, Folder, Message, View } from '../../mail/core/index.ts';
import {
  bodyQuery,
  conversationQuery,
  conversationsQuery,
  mailroom,
  type Page,
  type PageCursor,
} from '../../mailroom/client/index.ts';
import {
  changeMessages,
  commandFor,
  followMoves,
  overlaid,
  rowChange,
  undoOf,
  type Action,
  type Command,
  type Moved,
} from '../core/triage.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import { overlaysOf } from './overlays.ts';

/** Triages some of a view's conversations, by default saying so with a way to undo it. */
export type Triage = (
  action: Action,
  conversations: readonly ConversationId[],
  options?: { quietly?: boolean },
) => void;

type Pages = InfiniteData<Page, PageCursor | undefined>;

/**
 * Triage from the browser. The list shows the change at once, laid over its snapshot until the
 * Mailroom's own list shows it, and the open conversation shows a flag or read mark. Once the mail
 * server has it, a toast says what happened and offers Undo. If the server refuses, the overlay is
 * lifted, so the rows return as they were, and a toast says why. A move, and the Undo that moves
 * back, give messages new refs, which the conversation takes as soon as the Mailroom reports them.
 */
export function useTriage(
  view: View,
  folders: readonly Folder[],
): { triage: Triage; undoLast: () => void; canUndo: boolean } {
  const queryClient = useQueryClient();
  // The last triage the toast offered to undo, which Undo's key undoes too, once.
  const last = useRef<(() => void) | undefined>(undefined);
  const [canUndo, setCanUndo] = useState(false);
  const undoLast = useCallback(() => {
    const undo = last.current;
    last.current = undefined;
    setCanUndo(false);
    undo?.();
  }, []);

  const triage = useCallback<Triage>(
    (action, ids, { quietly = false } = {}) => {
      const overlays = overlaysOf(queryClient);
      const pages = queryClient.getQueryData<Pages>(conversationsQuery(view).queryKey);
      const listed = overlaid(pages?.pages.flatMap(({ items }) => items) ?? [], overlays.on(view));
      const earlierRows = listed.filter(({ id }) => ids.includes(id));
      const earlierMessages = new Map<ConversationId, Message[]>();
      const change = rowChange(action, view);
      const laid = change && overlays.lay(view, { ids: new Set(ids), change });

      const restoreMessages = () => {
        for (const [id, messages] of earlierMessages) {
          queryClient.setQueryData(conversationQuery(id).queryKey, messages);
        }
      };
      const refused = (error: unknown, doing: string) => {
        void toast({ type: 'error', body: `Couldn't ${doing}. ${reasonOf(error)}` });
        for (const id of ids) {
          void queryClient.invalidateQueries({ queryKey: conversationQuery(id).queryKey });
        }
      };
      const undo = async (command: Command, moved: readonly Moved[]) => {
        if (laid) overlays.lift(laid);
        const back = overlays.lay(view, { returning: earlierRows });
        // The refs from before a move are retired, so a move back waits for the refs it gives.
        if ('setFlags' in command) restoreMessages();
        try {
          for (const step of undoOf(command, moved)) follow(queryClient, ids, await send(step));
          overlays.settle(back);
        } catch (error) {
          overlays.lift(back);
          refused(error, 'undo that');
        }
      };

      void (async () => {
        try {
          const conversations = await Promise.all(
            ids.map((id) => queryClient.ensureQueryData(conversationQuery(id))),
          );
          const command = commandFor(action, view, conversations, folders);
          if (!command) {
            if (laid) overlays.lift(laid);
            return;
          }
          for (const [at, id] of ids.entries()) {
            const messages = conversations[at] ?? [];
            earlierMessages.set(id, messages);
            queryClient.setQueryData(
              conversationQuery(id).queryKey,
              changeMessages(messages, command),
            );
          }
          const moved = await send(command);
          follow(queryClient, ids, moved);
          if (laid) overlays.settle(laid);
          if (quietly) return;
          // The toast's Undo spends the key's undo too, so neither undoes it twice.
          const undoThis = () => {
            if (last.current === undoFromKey) {
              last.current = undefined;
              setCanUndo(false);
            }
            void undo(command, moved);
          };
          const dismissing = toast({
            body: said(action, ids.length, folders),
            action: { label: 'Undo', onAction: undoThis },
          });
          const undoFromKey = () => {
            void dismissing.then((dismiss) => dismiss());
            void undo(command, moved);
          };
          last.current = undoFromKey;
          setCanUndo(true);
        } catch (error) {
          if (laid) overlays.lift(laid);
          restoreMessages();
          refused(error, doingOf(action, folders));
        }
      })();
    },
    [queryClient, view, folders],
  );
  return { triage, undoLast, canUndo };
}

/**
 * Gives some conversations' snapshots the refs their messages moved to, so nothing asks for a
 * message by a ref its move retired. A body is the same wherever its message is, so one already
 * fetched is kept under the new ref too.
 */
function follow(queryClient: QueryClient, ids: readonly ConversationId[], moved: readonly Moved[]) {
  for (const id of ids) {
    const { queryKey } = conversationQuery(id);
    const messages = queryClient.getQueryData(queryKey);
    const followed = messages && followMoves(messages, moved);
    if (followed) queryClient.setQueryData(queryKey, followed);
  }
  for (const { from, to } of moved) {
    const body = queryClient.getQueryData(bodyQuery(from).queryKey);
    if (body) queryClient.setQueryData(bodyQuery(to).queryKey, body);
  }
}

/** Asks the Mailroom to carry out a command, and says where each moved message went. */
async function send(command: Command): Promise<Moved[]> {
  if ('move' in command) return mailroom.move(command.move, command.to);
  await mailroom.setFlags(command.setFlags, command.change);
  return [];
}

/** What a toast says once the server has an action: "Archived", or "Moved 3 conversations to Receipts". */
function said(action: Action, count: number, folders: readonly Folder[]): string {
  const how = {
    archive: 'Archived',
    delete: 'Deleted',
    move: 'Moved',
    flag: 'Flagged',
    unflag: 'Unflagged',
    read: 'Marked read',
    unread: 'Marked unread',
  }[action.do];
  const what = count === 1 ? '' : ` ${count} conversations`;
  const where = action.do === 'move' ? ` to ${destinationName(action.to, folders)}` : '';
  return `${how}${what}${where}`;
}

/** What a refusal says the member was doing: "Couldn't archive." */
function doingOf(action: Action, folders: readonly Folder[]): string {
  switch (action.do) {
    case 'move':
      return `move to ${destinationName(action.to, folders)}`;
    case 'read':
    case 'unread':
      return `mark ${action.do}`;
    default:
      return action.do;
  }
}

function destinationName(to: { account: string; path: string }, folders: readonly Folder[]) {
  const folder = folders.find(({ account, path }) => account === to.account && path === to.path);
  return folder ? folderName(folder) : to.path;
}
