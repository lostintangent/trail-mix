import type { QueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { boundTooltipOf, UNDO_COMMAND } from '../../commands/index.ts';
import { folderName } from '../../folders/index.ts';
import {
  bundlePartsOf,
  isBundle,
  type BundleSummary,
  type ConversationId,
  type Folder,
  type ListItem,
  type Message,
  type View,
} from '../../mail/core/index.ts';
import { bodyQuery, conversationQuery, mailroom } from '../../mailroom/client/index.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import {
  bundleCommandFor,
  changeMessages,
  commandFor,
  followMoves,
  undoOf,
  type BundleCommand,
  type Command,
  type Moved,
} from '../core/carrying.ts';
import type { Action } from '../core/triage.ts';
import type { Laid, ListOf, Overlays } from './overlays.ts';
import { fetchedList } from './useConversations.ts';

/**
 * Carrying out a triage, once the rows have shown it: the Mailroom told, the open conversation
 * changed, and a toast that says what happened with Undo. It loads apart from the first screen,
 * since the rows change in the triage's own frame without it.
 */

/** A triage the rows already show, and what carrying it out needs. */
export type Triaged = {
  queryClient: QueryClient;
  /** The view the rows were triaged in, which says what a move takes out. */
  view: View;
  /** The list the rows lie in: the view's, or a bundle's in it. */
  list: ListOf;
  folders: readonly Folder[];
  action: Action;
  ids: readonly ConversationId[];
  quietly: boolean;
  overlays: Overlays;
  /** What the rows show of it, until the Mailroom's own list does. */
  laid: Laid | undefined;
  /** The rows as they were, which Undo puts back. */
  earlierRows: readonly ListItem[];
  /** The key that undoes the last triage: offered this one's Undo, or spent by the toast's. */
  undoKey: { offer: (undo: () => void) => void; spend: (undo: () => void) => void };
  /** Once the server has refused it and the rows are back as they were. */
  onRefused: (() => void) | undefined;
};

export async function carryOut({
  queryClient,
  view,
  list,
  folders,
  action,
  ids,
  quietly,
  overlays,
  laid,
  earlierRows,
  undoKey,
  onRefused,
}: Triaged): Promise<void> {
  // A bundle's row is carried out by the Mailroom, as far as the row showed it, and its
  // conversations, as far as this browser holds them, follow what it reports.
  const bundles = earlierRows.filter(isBundle);
  const conversationIds = ids.filter((id) => bundlePartsOf(id) === undefined);
  const followed = [
    ...conversationIds,
    ...bundles.flatMap((bundle) => threadsOf(queryClient, bundle)),
  ];
  const earlierMessages = new Map<ConversationId, Message[]>();
  const restoreMessages = () => {
    for (const [id, messages] of earlierMessages) {
      queryClient.setQueryData(conversationQuery(id).queryKey, messages);
    }
  };
  const refused = (error: unknown, doing: string) => {
    void toast({ type: 'error', body: `Couldn't ${doing}. ${reasonOf(error)}` });
    for (const id of followed) {
      void queryClient.invalidateQueries({ queryKey: conversationQuery(id).queryKey });
    }
  };
  const carry = async (command: Command | BundleCommand) => {
    const carried = await send(command);
    follow(queryClient, followed, carried);
    return carried;
  };
  const undo = async (done: readonly Carried[]) => {
    if (laid) overlays.lift(laid);
    const back = overlays.lay(list, { returning: earlierRows });
    // The refs from before a move are retired, so a move back waits for the refs it gives.
    if (done.some(({ command }) => 'setFlags' in command)) restoreMessages();
    try {
      // Every step leaves at once, since each moves its own messages, so a page that closes the
      // moment it shows them back has already asked for all of them.
      const steps = done.flatMap(({ command, moved }) => undoOf(command, moved));
      await Promise.all(steps.map(carry));
      overlays.settle(back);
    } catch (error) {
      overlays.lift(back);
      refused(error, 'undo that');
    }
  };

  try {
    const conversations = await Promise.all(
      conversationIds.map((id) => queryClient.ensureQueryData(conversationQuery(id))),
    );
    const command =
      conversations.length > 0 ? commandFor(action, view, conversations, folders) : undefined;
    const commands = [
      ...(command ? [command] : []),
      ...bundles.flatMap((bundle) => bundleCommandFor(action, bundle, folders) ?? []),
    ];
    if (commands.length === 0) {
      if (laid) overlays.lift(laid);
      return;
    }
    if (command) {
      for (const [at, id] of conversationIds.entries()) {
        const messages = conversations[at] ?? [];
        earlierMessages.set(id, messages);
        queryClient.setQueryData(conversationQuery(id).queryKey, changeMessages(messages, command));
      }
    }
    const done: Carried[] = [];
    for (const each of commands) done.push(await carry(each));
    if (laid) overlays.settle(laid);
    if (quietly) return;
    // The toast's Undo spends the key's undo too, so neither undoes it twice.
    const undoThis = () => {
      undoKey.spend(undoFromKey);
      void undo(done);
    };
    const count = conversationIds.length + bundles.reduce((sum, { threads }) => sum + threads, 0);
    const dismissing = toast({
      body: said(action, count, folders),
      action: {
        label: 'Undo',
        icon: Undo2,
        tooltip: boundTooltipOf(UNDO_COMMAND),
        onAction: undoThis,
      },
    });
    const undoFromKey = () => {
      void dismissing.then((dismiss) => dismiss());
      void undo(done);
    };
    undoKey.offer(undoFromKey);
  } catch (error) {
    if (laid) overlays.lift(laid);
    restoreMessages();
    refused(error, doingOf(action, folders));
    onRefused?.();
  }
}

/** A command the Mailroom carried out, by the messages it changed, and where each moved one went. */
type Carried = { command: Command; moved: Moved[] };

/** The conversations of a bundle this browser holds. */
const threadsOf = (queryClient: QueryClient, bundle: BundleSummary): ConversationId[] =>
  fetchedList(queryClient, bundle.id)?.flatMap((row) => (row ? [row.id] : [])) ?? [];

/**
 * Gives some conversations' snapshots what a command did to them: the flags it changed, and the refs
 * their messages moved to, so nothing asks for a message by a ref its move retired. A body is the
 * same wherever its message is, so one already fetched is kept under the new ref too.
 */
function follow(
  queryClient: QueryClient,
  ids: readonly ConversationId[],
  { command, moved }: Carried,
) {
  for (const id of ids) {
    const { queryKey } = conversationQuery(id);
    const messages = queryClient.getQueryData(queryKey);
    if (!messages) continue;
    const changed = changeMessages(messages, command);
    const isChanged = changed.some((message, at) => message !== messages[at]);
    const followed = followMoves(changed, moved) ?? (isChanged ? changed : undefined);
    if (followed) queryClient.setQueryData(queryKey, followed);
  }
  for (const { from, to } of moved) {
    const body = queryClient.getQueryData(bodyQuery(from).queryKey);
    if (body) queryClient.setQueryData(bodyQuery(to).queryKey, body);
  }
}

/**
 * Asks the Mailroom to carry out a command, and says what it changed: the messages given, or those
 * of a bundle it found, and where each moved one went.
 */
async function send(command: Command | BundleCommand): Promise<Carried> {
  if ('move' in command) {
    const moved = await mailroom.move(command.move, command.to);
    return { command: { move: moved.map(({ from }) => from), to: command.to }, moved };
  }
  const changed = await mailroom.setFlags(command.setFlags, command.change);
  return { command: { setFlags: changed, change: command.change }, moved: [] };
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
