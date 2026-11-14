import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import type { Address, MessageRef } from '../../mail/core/index.ts';
import { closesAfterPress } from '../core/standing.ts';
import { handed, pressed } from './asked.ts';

/**
 * A press of Send. The composer has closed, and its message's last save finishes behind it, so the
 * undo window counts from the press while the save runs.
 */
export type Press = {
  id: string;
  /** The draft the message sends, once its last save is done. Stops saving once `signal` aborts. */
  saved: (signal: AbortSignal) => Promise<MessageRef>;
  /** Whom it goes to, as it was written. */
  to: readonly Address[];
  /** When to send, as an instant. A time inside the undo window sends when the window closes. */
  at: string | undefined;
  pressedAt: number;
  /** Brings the message back to a composer, once Undo has stopped or taken back the send. */
  onUndone: () => void;
  /** The message couldn't be saved, or the Mailroom refused it, and why. */
  onFailed: (reason: string) => void;
};

export type Send = (press: Press) => void;

/** The Outbox's browser code, which the first screen goes without. */
export const loadSending = () => import('./sending.tsx');

/**
 * Send from the browser: followed from the press, and handed to the Mailroom once its message's
 * last save is done. Once the Mailroom has the send, the Outbox shows it, and this device follows
 * it: a countdown with Undo through the undo window, or the time it goes, then what came of it. If
 * the save fails or the Mailroom refuses, `onFailed` hears why.
 */
export function useSend(): Send {
  const queryClient = useQueryClient();
  return useCallback(
    (press) => {
      const handOff = new AbortController();
      pressed(press.id, {
        closes: closesAfterPress(press.pressedAt, press.at),
        onUndone: press.onUndone,
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
