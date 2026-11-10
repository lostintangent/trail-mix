import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback } from 'react';
import { folderName } from '../../folders/index.ts';
import type { ConversationId, Folder, Message, View } from '../../mail/core/index.ts';
import {
  conversationQuery,
  conversationsQuery,
  mailroom,
  type Page,
  type PageCursor,
} from '../../mailroom/client/index.ts';
import {
  changeMessages,
  commandFor,
  overlaid,
  rowChange,
  undoOf,
  type Action,
  type Command,
  type Moved,
} from '../core/triage.ts';
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
 * lifted, so the rows return as they were, and a toast says why.
 */
export function useTriage(view: View, folders: readonly Folder[]): Triage {
  const queryClient = useQueryClient();

  return useCallback(
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
        restoreMessages();
        try {
          for (const step of undoOf(command, moved)) await send(step);
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
          if (laid) overlays.settle(laid);
          if (quietly) return;
          void toast({
            body: said(action, ids.length, folders),
            action: { label: 'Undo', onAction: () => void undo(command, moved) },
          });
        } catch (error) {
          if (laid) overlays.lift(laid);
          restoreMessages();
          refused(error, doingOf(action, folders));
        }
      })();
    },
    [queryClient, view, folders],
  );
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

/** The server's own reason, which the Mailroom passes on as the error's message. */
function reasonOf(error: unknown): string {
  const reason = error instanceof Error ? error.message.trim() : '';
  if (!reason) return 'The mail server gave no reason.';
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}
