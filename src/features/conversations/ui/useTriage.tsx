import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BundleId, ConversationId, Folder, ListItem, View } from '../../mail/core/index.ts';
import { overlaid, rowChange, type Action } from '../core/triage.ts';
import { afterFirstScreen } from '../../../shared/afterFirstScreen.ts';
import { afterPaint } from '../../../shared/afterPaint.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import { overlaysOf, type ListOf } from './overlays.ts';
import { fetchedRows } from './useConversations.ts';

/**
 * Triages some of a view's rows, conversations or bundles, by default saying so with a way to undo
 * it.
 */
type Triage = (
  action: Action,
  rows: readonly ConversationId[],
  options?: {
    quietly?: boolean;
    /** Once the server has refused it and the rows are back as they were. */
    onRefused?: () => void;
    /** The bundle whose conversations they are, when they lie in its list rather than the view's. */
    in?: BundleId;
  },
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
  useEffect(() => afterFirstScreen(loadCarrying), []);
  // Read as a triage starts, so `triage` stays the same function as counts change, and every row
  // it's handed to doesn't draw again for a folder's count.
  const latestFolders = useRef(folders);
  useLayoutEffect(() => {
    latestFolders.current = folders;
  });

  const triage = useCallback<Triage>(
    (action, ids, { quietly = false, onRefused, in: bundle } = {}) => {
      const folders = latestFolders.current;
      const overlays = overlaysOf(queryClient);
      const list: ListOf = bundle ?? view;
      const fetched = fetchedRows(queryClient, list, ids);
      const listed = overlaid<ListItem>(fetched, overlays.on(list));
      const earlierRows = listed.filter(
        (row): row is ListItem => row !== undefined && ids.includes(row.id),
      );
      const change = rowChange(action, view);
      const laid = change && overlays.lay(list, { ids: new Set(ids), change });

      void (async () => {
        // The rows show the change in this frame. Telling the Mailroom waits until it has painted.
        await afterPaint();
        try {
          const { carryOut } = await loadCarrying();
          await carryOut({
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
          });
        } catch (error) {
          // Only what carries it out failing to load reaches here, so the rows go back as they were.
          if (laid) overlays.lift(laid);
          void toast({ type: 'error', body: `Couldn't do that. ${reasonOf(error)}` });
          onRefused?.();
        }
      })();
    },
    [queryClient, view, undoKey],
  );
  return { triage, undoLast, canUndo };
}

const loadCarrying = () => import('./carrying.ts');
