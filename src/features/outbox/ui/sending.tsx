import type { QueryClient } from '@tanstack/react-query';
import { Suspense } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { mailroom, outboxQuery } from '../../mailroom/client/index.ts';
import { formatAhead } from '../core/later.ts';
import { UNDO_SECONDS } from '../core/outbox.ts';
import { briefly, closesAfterPress, closesAt } from '../core/standing.ts';
import { rememberClosing } from './closings.ts';
import LeavingToast from './LeavingToast.tsx';

/**
 * What the browser does with the Outbox, loaded when it's first wanted rather than with the first
 * screen. Each change shows in the Outbox once the Mailroom has it, and a refusal says why in a
 * toast and leaves the Outbox as the Mailroom has it.
 */

export type SendOptions = {
  /** When to send, as an instant. A time inside the undo window sends when the window closes. */
  at?: string;
  /** Hands back the draft once Undo has taken the send back, as the composer reopens it. */
  onUndone?: (draft: MessageRef) => void;
};

/** The toasts following sends, by send, so a send asked for again replaces its toast. */
const following = new Map<string, () => void>();

/**
 * Schedules a saved draft. Once the Mailroom has the send, the Outbox shows it, and a toast follows
 * it: a countdown with Undo through the undo window, or the time it goes, then what came of it.
 */
export async function sendDraft(
  queryClient: QueryClient,
  draft: MessageRef,
  { at, onUndone }: SendOptions = {},
): Promise<Outgoing | undefined> {
  const pressed = Date.now();
  let outgoing: Outgoing;
  try {
    outgoing = await mailroom.send(draft, at);
  } catch (error) {
    void toast({ type: 'error', body: `Couldn’t send. ${reasonOf(error)}` });
    return undefined;
  }
  const isLater = at !== undefined && Date.parse(at) > closesAfterPress(pressed);
  const closes = isLater ? closesAt(outgoing) : closesAfterPress(pressed);
  rememberClosing(outgoing.id, closes);
  // A snapshot asked for before the Mailroom had the send would take it out of the Outbox again.
  await queryClient.cancelQueries({ queryKey: outboxQuery.queryKey });
  queryClient.setQueryData(outboxQuery.queryKey, (held = []) => [
    ...held.filter(({ id }) => id !== outgoing.id),
    outgoing,
  ]);

  following.get(outgoing.id)?.();
  const who = briefly(outgoing.to);
  const dismiss = await toast({
    body: isLater
      ? `Sending to ${who} ${formatAhead(outgoing.sendAt)}`
      : `Sending to ${who} in ${UNDO_SECONDS} seconds`,
    render: (dismiss) => (
      <Suspense>
        <LeavingToast
          outgoing={outgoing}
          closes={closes}
          dismiss={() => {
            following.delete(outgoing.id);
            dismiss();
          }}
          onUndone={onUndone}
        />
      </Suspense>
    ),
  });
  following.set(outgoing.id, dismiss);
  return outgoing;
}

/** Undo, Retry and Edit for a send the Outbox holds. Edit takes the send back, so its draft opens. */
export function outboxActions(queryClient: QueryClient) {
  const update = (change: (held: Outgoing[]) => Outgoing[]) =>
    queryClient.setQueryData(outboxQuery.queryKey, (held) => held && change(held));
  const refused = (doing: string, error: unknown) => {
    void toast({ type: 'error', body: `Couldn’t ${doing}. ${reasonOf(error)}` });
    void queryClient.invalidateQueries({ queryKey: outboxQuery.queryKey });
  };
  const takeBack = async (outgoing: Outgoing, doing: string) => {
    try {
      await mailroom.cancelSend(outgoing.id);
      update((held) => held.filter(({ id }) => id !== outgoing.id));
      return true;
    } catch (error) {
      refused(doing, error);
      return false;
    }
  };
  return {
    undo: (outgoing: Outgoing) => takeBack(outgoing, 'undo'),
    edit: (outgoing: Outgoing) => takeBack(outgoing, 'take it back to edit'),
    retry: async (outgoing: Outgoing) => {
      try {
        const retried = await mailroom.retrySend(outgoing.id);
        update((held) => held.map((each) => (each.id === retried.id ? retried : each)));
      } catch (error) {
        refused('retry', error);
      }
    },
  };
}

export type OutboxActions = ReturnType<typeof outboxActions>;
