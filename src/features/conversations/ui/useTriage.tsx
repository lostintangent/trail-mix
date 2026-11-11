import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationId, ConversationSummary, Folder, View } from '../../mail/core/index.ts';
import { overlaid, rowChange, type Action } from '../core/triage.ts';
import { afterFirstScreen } from '../../../shared/afterFirstScreen.ts';
import { afterPaint } from '../../../shared/afterPaint.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import { overlaysOf } from './overlays.ts';
import { fetchedRows } from './useConversations.ts';

/** Triages some of a view's conversations, by default saying so with a way to undo it. */
export type Triage = (
  action: Action,
  conversations: readonly ConversationId[],
  options?: { quietly?: boolean },
) => void;

/**
 * Triage from the browser. The list shows the change at once, laid over its snapshot until the
 * Mailroom's own list shows it, and the open conversation shows a flag or read mark. Once the mail
 * server has it, a toast says what happened and offers Undo. If the server refuses, the overlay is
 * lifted, so the rows return as they were, and a toast says why. A move, and the Undo that moves
 * back, give messages new refs, which the conversation takes as soon as the Mailroom reports them.
 */
export function useTriage(
  view: View,
  folders: readonly Folder[],
): { triage: Triage; undoLast: () => void; canUndo: boolean } {
  const queryClient = useQueryClient();
  // The last triage the toast offered to undo, which Undo's key undoes too, once.
  const last = useRef<(() => void) | undefined>(undefined);
  const [canUndo, setCanUndo] = useState(false);
  const undoLast = useCallback(() => {
    const undo = last.current;
    last.current = undefined;
    setCanUndo(false);
    undo?.();
  }, []);

  // The key that undoes the last triage, once.
  const undoKey = useMemo(
    () => ({
      offer: (undo: () => void) => {
        last.current = undo;
        setCanUndo(true);
      },
      spend: (undo: () => void) => {
        if (last.current !== undo) return;
        last.current = undefined;
        setCanUndo(false);
      },
    }),
    [],
  );
  // What carries a triage out loads once the first screen has settled, ready before the first one.
  useEffect(() => afterFirstScreen(() => void loadCarrying()), []);

  const triage = useCallback<Triage>(
    (action, ids, { quietly = false } = {}) => {
      const overlays = overlaysOf(queryClient);
      const listed = overlaid(fetchedRows(queryClient, view, ids), overlays.on(view));
      const earlierRows = listed.filter(
        (row): row is ConversationSummary => row !== undefined && ids.includes(row.id),
      );
      const change = rowChange(action, view);
      const laid = change && overlays.lay(view, { ids: new Set(ids), change });

      void (async () => {
        // The rows show the change in this frame. Telling the Mailroom waits until it has painted.
        await afterPaint();
        try {
          const { carryOut } = await loadCarrying();
          await carryOut({
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
          });
        } catch (error) {
          // Only what carries it out failing to load reaches here, so the rows go back as they were.
          if (laid) overlays.lift(laid);
          void toast({ type: 'error', body: `Couldn't do that. ${reasonOf(error)}` });
        }
      })();
    },
    [queryClient, view, folders, undoKey],
  );
  return { triage, undoLast, canUndo };
}

const loadCarrying = () => import('./carrying.ts');
