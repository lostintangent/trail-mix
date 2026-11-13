import { useQueries, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import type { Command } from '../../commands/index.ts';
import type { Body, ConversationId, Message, MessageRef } from '../../mail/core/index.ts';
import { bodyQuery, conversationQuery, mailroom } from '../../mailroom/client/index.ts';
import { refOf } from './refs.ts';

/**
 * One-click unsubscribe in the browser. A message offers it when its body names a one-click
 * address, and the Mailroom posts there and says whether the sender took it. Nothing keeps the
 * answer, so this page holds what it asked by the list's address, and every sheet of that list's
 * mail and the palette say the same.
 */

/** Where unsubscribing from one list stands on this page. */
export type Unsubscribing =
  { is: 'offered' } | { is: 'asking' } | { is: 'taken' } | { is: 'refused'; reason: string };

/** Asks the Mailroom to unsubscribe from the list at `address`, unless it is asking or has. */
export function unsubscribe(ref: MessageRef, address: string) {
  const now = asked.get(address);
  if (now?.is === 'asking' || now?.is === 'taken') return;
  tell(address, { is: 'asking' });
  mailroom.unsubscribe(refOf(ref)).then(
    (answer) =>
      tell(address, answer.taken ? { is: 'taken' } : { is: 'refused', reason: answer.reason }),
    (error: unknown) => tell(address, { is: 'refused', reason: reasonOf(error) }),
  );
}

/** Where unsubscribing from the list at `address` stands. */
export function useUnsubscribing(address: string): Unsubscribing {
  return useSyncExternalStore(listen, () => asked.get(address) ?? OFFERED);
}

/**
 * Unsubscribe as a command, for the conversation open: from the list its newest list mail came
 * from, once that message's body, which the reader fetches, offers it. It reads only what the
 * reader has fetched, and changes only when the offer does, so moving through the list asks for
 * nothing more and renders nothing more.
 */
export function useUnsubscribeCommand(open: ConversationId | undefined): Command {
  const { data: ref } = useQuery({
    ...conversationQuery(open ?? ''),
    enabled: false,
    select: newestListMail,
  });
  const address = useQueries({
    queries: (ref ? [ref] : []).map((each) => ({
      ...bodyQuery(each),
      enabled: false,
      select: offerOf,
    })),
    combine: ([offer]) => offer?.data,
  });
  const standing = useUnsubscribing(address ?? '');
  return {
    id: 'message.unsubscribe',
    title: 'Unsubscribe from this list',
    group: 'Message',
    isEnabled:
      ref !== undefined &&
      address !== undefined &&
      (standing.is === 'offered' || standing.is === 'refused'),
    run: () => ref && address && unsubscribe(ref, address),
  };
}

/** The newest message, not a draft, from a list its sender is verified for. */
function newestListMail(conversation: readonly Message[]): MessageRef | undefined {
  const newest = conversation
    .filter(({ flags, verified, list }) => !flags.draft && verified && list?.unsubscribe)
    .reduce<Message | undefined>(
      (latest, message) => (latest && latest.date >= message.date ? latest : message),
      undefined,
    );
  return newest && refOf(newest);
}

const offerOf = (body: Body) => body.unsubscribe;

const OFFERED: Unsubscribing = { is: 'offered' };
const asked = new Map<string, Unsubscribing>();
const listeners = new Set<() => void>();

function tell(address: string, standing: Unsubscribing) {
  asked.set(address, standing);
  for (const changed of listeners) changed();
}

function listen(changed: () => void): () => void {
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
  };
}
