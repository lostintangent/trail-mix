import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import type { SendOptions } from './sending.tsx';

export type { SendOptions };

/** Schedules a saved draft, and says what came of asking. */
export type Send = (draft: MessageRef, options?: SendOptions) => Promise<Outgoing | undefined>;

/** The Outbox's browser code, which the first screen goes without. */
export const loadSending = () => import('./sending.tsx');

/**
 * Send from the browser. Once the Mailroom has the send, the Outbox shows it, and this device
 * follows it: a countdown with Undo through the undo window, or the time it goes, then what came of
 * it. If the Mailroom refuses, a toast says why.
 */
export function useSend(): Send {
  const queryClient = useQueryClient();
  return useCallback(
    async (draft, options) => (await loadSending()).sendDraft(queryClient, draft, options),
    [queryClient],
  );
}
