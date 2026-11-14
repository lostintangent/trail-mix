import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { reasonOf } from '../../../shared/reasons.ts';
import { handed, pressed, type Press } from './asked.ts';

type Send = (press: Press) => void;

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
      pressed(press, () => handOff.abort());
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
