import type { QueryClient } from '@tanstack/react-query';
import { folderName } from '../../folders/index.ts';
import type {
  ConversationId,
  ConversationSummary,
  Folder,
  Message,
  View,
} from '../../mail/core/index.ts';
import { bodyQuery, conversationQuery, mailroom } from '../../mailroom/client/index.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import {
  changeMessages,
  commandFor,
  followMoves,
  undoOf,
  type Command,
  type Moved,
} from '../core/carrying.ts';
import type { Action } from '../core/triage.ts';
import type { Laid, Overlays } from './overlays.ts';

/**
 * Carrying out a triage, once the rows have shown it: the Mailroom told, the open conversation
 * changed, and a toast that says what happened with Undo. It loads apart from the first screen,
 * since the rows change in the triage's own frame without it.
 */

/** A triage the rows already show, and what carrying it out needs. */
export type Triaged = {
  queryClient: QueryClient;
  view: View;
  folders: readonly Folder[];
  action: Action;
  ids: readonly ConversationId[];
  quietly: boolean;
  overlays: Overlays;
  /** What the rows show of it, until the Mailroom's own list does. */
  laid: Laid | undefined;
  /** The rows as they were, which Undo puts back. */
  earlierRows: readonly ConversationSummary[];
  /** The key that undoes the last triage: offered this one's Undo, or spent by the toast's. */
  undoKey: { offer: (undo: () => void) => void; spend: (undo: () => void) => void };
};

export async function carryOut({
  queryClient,
  view,
  folders,
  action,
  ids,
  quietly,
  overlays,
  laid,
  earlierRows,
  undoKey,
}: Triaged): Promise<void> {
  const earlierMessages = new Map<ConversationId, Message[]>();
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
      queryClient.setQueryData(conversationQuery(id).queryKey, changeMessages(messages, command));
    }
    const moved = await send(command);
    follow(queryClient, ids, moved);
    if (laid) overlays.settle(laid);
    if (quietly) return;
    // The toast's Undo spends the key's undo too, so neither undoes it twice.
    const undoThis = () => {
      undoKey.spend(undoFromKey);
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
    undoKey.offer(undoFromKey);
  } catch (error) {
    if (laid) overlays.lift(laid);
    restoreMessages();
    refused(error, doingOf(action, folders));
  }
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
