import { useCallback, useLayoutEffect, useState } from 'react';
import type { ListItem, View } from '../../mail/core/index.ts';

/**
 * A view that arrives naming no conversation opens at its newest, on a desktop, where the reader
 * lies beside the list and so always belongs to it. The Outbox lists sends, not conversations, and
 * a phone shows the list alone. A list still empty may be filling, as a new member's first sync
 * fills it, so the view waits for its newest, unless the reader is taken first.
 */
export function useOpensNewest({
  view,
  isPhone,
  isNaming,
  newest,
  isReaderTaken,
  open,
}: {
  view: View;
  isPhone: boolean;
  /** Whether the place the workbench starts at names what to open. */
  isNaming: boolean;
  /** The view's newest conversation, once its list holds it. */
  newest: ListItem | undefined;
  /** Whether the reader holds something already: a conversation, a message written or a page. */
  isReaderTaken: boolean;
  /** Opens the newest, the same function every render. */
  open: (newest: ListItem) => void;
}) {
  const [opening, setOpening] = useState(() => (isNaming ? undefined : opensAt(view, isPhone)));
  // Before the frame is drawn, so the reader shows no empty sheet between the two.
  useLayoutEffect(() => {
    if (opening === undefined) return;
    if (opening !== view || isReaderTaken) {
      setOpening(undefined);
      return;
    }
    if (newest === undefined) return;
    setOpening(undefined);
    open(newest);
  }, [opening, view, isReaderTaken, newest, open]);
  return {
    /** Opens a view at its newest, where it opens one, once its list holds it. */
    openAt: useCallback((next: View) => setOpening(opensAt(next, isPhone)), [isPhone]),
    /** Leaves the reader as it is, as the member's own pick does. */
    cancel: useCallback(() => setOpening(undefined), []),
  };
}

const opensAt = (view: View, isPhone: boolean) =>
  !isPhone && view.in !== 'outbox' ? view : undefined;
