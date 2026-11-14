import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import type { Address, MessageRef } from '../../mail/core/index.ts';
import type { LastSave } from '../../mailroom/client/index.ts';
import { closesAfterPress } from '../core/standing.ts';
import { handed, pressed } from './asked.ts';

/**
 * A press of Send. The composer has closed, and the message goes to the Mailroom in one request,
 * carrying its last save if it has changes unsaved, so the undo window counts from the press. A
 * request that gets no answer asks again under the press, so the message comes back only once the
 * Mailroom has refused it or Undo has taken it back.
 */
export type Press = {
  id: string;
  /**
   * What the message sends, once any save already on its way has answered: its draft, or its last
   * save. Stops waiting once `signal` aborts.
   */
  last: (signal: AbortSignal) => Promise<MessageRef | LastSave>;
  /** Whom it goes to, as it was written. */
  to: readonly Address[];
  /** When to send, as an instant. A time inside the undo window sends when the window closes. */
  at: string | undefined;
  pressedAt: number;
  /** The Mailroom has the send, and the draft it sends. */
  onSent: (draft: MessageRef) => void;
  /**
   * Brings the message back to a composer, once Undo has stopped or taken back the send, as the
   * draft the Mailroom kept, if it filed one.
   */
  onUndone: (draft?: MessageRef) => void;
  /** The message couldn't be saved, or the Mailroom refused it, and why. */
  onFailed: (reason: string) => void;
};

export type Send = (press: Press) => void;

/** The Outbox's browser code, which the first screen goes without. */
export const loadSending = () => import('./sending.tsx');

/**
 * Send from the browser: followed from the press, and handed to the Mailroom with its message's
 * last save. Once the Mailroom has the send, the Outbox shows it, and this device follows it: a
 * countdown with Undo through the undo window, or the time it goes, then what came of it. If the
 * Mailroom refuses, `onFailed` hears why.
 */
export function useSend(): Send {
  const queryClient = useQueryClient();
  return useCallback(
    (press) => {
      const handOff = new AbortController();
      pressed(press.id, {
        closes: closesAfterPress(press.pressedAt, press.at),
        onUndone: press.onUndone,
        onFailed: press.onFailed,
        stop: () => handOff.abort(),
      });
      loadSending().then(
        (sending) => sending.handOff(queryClient, press, handOff.signal),
        (error: unknown) => {
          handed(press.id, { is: 'failed' });
          press.onFailed(reasonOf(error));
        },
      );
    },
    [queryClient],
  );
}
