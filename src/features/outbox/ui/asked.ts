import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { mailroom, outboxQuery } from '../../mailroom/client/index.ts';
import { closesAt } from '../core/standing.ts';

/**
 * The sends this device asked for: when each one's undo window closes on its own clock, so its
 * line, its toast and its Outbox row count down alike, and what Undo hands its draft back to. A send
 * asked for elsewhere trusts this device's clock.
 */
export type Asked = {
  closes: number;
  /** Hands back the draft once Undo has taken the send back, as the composer reopens it. */
  onUndone?: (draft: MessageRef) => void;
};

const asked = new Map<string, Asked>();
const listeners = new Set<() => void>();
let version = 0;

export function rememberAsked(id: string, send: Asked) {
  asked.set(id, send);
  version++;
  for (const listener of listeners) listener();
}

export const isAsked = (id: string) => asked.has(id);

export function closesFor(outgoing: Outgoing): number {
  return asked.get(outgoing.id)?.closes ?? closesAt(outgoing);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Changes whenever this device asks for a send, which can be after a snapshot of the Outbox has
 * already brought it, as when the Mailroom's hint outruns its answer.
 */
export const useAskedVersion = () => useSyncExternalStore(subscribe, () => version);

/**
 * Takes a send back, and hands its draft to whoever asked for it. Says why not if the Mailroom
 * refused: an Undo that reached it after the window closed was too late, whatever the send has
 * come to since, and anything else says the Mailroom's reason.
 */
export async function takeBack(
  queryClient: QueryClient,
  outgoing: Outgoing,
): Promise<string | undefined> {
  try {
    const draft = await mailroom.cancelSend(outgoing.id);
    queryClient.setQueryData(outboxQuery.queryKey, (held) =>
      held?.filter(({ id }) => id !== outgoing.id),
    );
    asked.get(outgoing.id)?.onUndone?.(draft);
    return undefined;
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: outboxQuery.queryKey });
    return Date.now() >= closesFor(outgoing)
      ? 'Too late to undo.'
      : `Couldn’t undo. ${reasonOf(error)}`;
  }
}
