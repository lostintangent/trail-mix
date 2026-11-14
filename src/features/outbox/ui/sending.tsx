import type { QueryClient } from '@tanstack/react-query';
import { Suspense } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { mailroom, outboxQuery } from '../../mailroom/client/index.ts';
import type { Leaving } from '../core/leaving.ts';
import { briefly, type Standing } from '../core/standing.ts';
import { handed } from './asked.ts';
import LeavingToast, { said } from './LeavingToast.tsx';
import type { Press } from './useSend.ts';

/**
 * What the browser does with the Outbox, loaded when it's first wanted rather than with the first
 * screen. Each change shows in the Outbox once the Mailroom has it, and a refusal says why in a
 * toast and leaves the Outbox as the Mailroom has it.
 */

/**
 * Hands a press to the Mailroom once its message's last save is done, asking for the undo window
 * to count from the press. Once the Mailroom has the send, the Outbox shows it, and this device
 * follows it as one it asked for. A save that fails, or a send the Mailroom refuses, says why to
 * the press. Undo stops it while it saves.
 */
export async function handOff(queryClient: QueryClient, press: Press, signal: AbortSignal) {
  let draft: MessageRef;
  try {
    draft = await press.saved(signal);
  } catch (error) {
    if (!signal.aborted) fail(press, error);
    return;
  }
  if (signal.aborted) return;
  const answer = ask(queryClient, press, draft);
  handed(press.id, { is: 'asking', answer });
  await answer;
}

async function ask(
  queryClient: QueryClient,
  press: Press,
  draft: MessageRef,
): Promise<Outgoing | undefined> {
  let outgoing: Outgoing;
  try {
    outgoing = await mailroom.send(draft, press.at, Math.max(0, Date.now() - press.pressedAt));
  } catch (error) {
    fail(press, error);
    return undefined;
  }
  handed(press.id, { is: 'asked', send: outgoing });
  // A snapshot asked for before the Mailroom had the send would take it out of the Outbox again.
  await queryClient.cancelQueries({ queryKey: outboxQuery.queryKey });
  queryClient.setQueryData(outboxQuery.queryKey, (held = []) => [
    ...held.filter(({ id }) => id !== outgoing.id),
    outgoing,
  ]);
  return outgoing;
}

function fail(press: Press, error: unknown) {
  handed(press.id, { is: 'failed' });
  press.onFailed(reasonOf(error));
}

/**
 * The toasts following the sends this device asked for, by press. One put away, as the member comes
 * to the send's conversation, can show again. One that ended, once it had nothing more to say or
 * the member dismissed it, never does.
 */
const toasts = new Map<string, { isShown: boolean; hasEnded: boolean; dismiss?: () => void }>();

/**
 * Shows the toast that follows a send, as it stands now: from the press, a countdown with Undo
 * through the undo window, or the time it goes, then what came of it. A send whose toast shows
 * already, or ended, shows nothing more.
 */
export function showLeavingToast(leaving: Leaving, standing: Standing) {
  const { id, seen, closes } = leaving;
  const was = toasts.get(id);
  if (was?.isShown || was?.hasEnded) return;
  const following: { isShown: boolean; hasEnded: boolean; dismiss?: () => void } = {
    isShown: true,
    hasEnded: false,
  };
  toasts.set(id, following);
  const to = seen?.last.to ?? leaving.to ?? [];
  const who = briefly(to);
  void toast({
    body:
      standing.is === 'counting'
        ? `Sending to ${who} in ${standing.seconds} seconds`
        : said(standing, who).text,
    render: (dismiss) => (
      <Suspense>
        <LeavingToast id={id} to={to} seen={seen} closes={closes} dismiss={dismiss} />
      </Suspense>
    ),
    // However it goes but put away, it has ended.
    onHide: () => {
      if (!following.isShown) return;
      following.isShown = false;
      following.hasEnded = true;
    },
  }).then((dismiss) => {
    if (following.isShown) following.dismiss = dismiss;
    else if (!following.hasEnded) dismiss();
  });
}

/** Puts a send's toast away, as its line in the conversation on screen says it all. */
export function putAwayLeavingToast(id: string) {
  const following = toasts.get(id);
  if (!following?.isShown) return;
  following.isShown = false;
  following.dismiss?.();
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
