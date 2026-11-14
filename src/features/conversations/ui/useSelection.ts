import { startTransition, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationId, ListItem } from '../../mail/core/index.ts';
import { idsIn, placesOf, type Listed } from '../core/pages.ts';
import {
  isSameSelection,
  NOTHING_SELECTED,
  pickedIn,
  placeAmong,
  select,
  selectOnly,
  type SelectBy,
  type Selection,
  type Vacating,
} from '../core/selection.ts';

const NO_PLACES: ReadonlyMap<ConversationId, number> = new Map();

/**
 * The conversations a member has selected in a list, and whether they are picking several. One
 * selected is the one open in the reader. Several wait for an action together. A conversation that
 * leaves the list gives way to the next, and a triage the server refuses brings the selection back.
 */
export function useSelection(
  conversations: Listed<ListItem> | undefined,
  /** The conversation or bundle selected from the first render, as the address opens it. */
  initial: ConversationId | undefined,
) {
  const [selection, setSelection] = useState(() => selectOnly(initial));
  const [isPicking, setPicking] = useState(false);
  // Picking ends with the last conversation picked.
  if (isPicking && selection.ids.length === 0) setPicking(false);
  const selected = selection.ids.length === 1 ? selection.ids[0] : undefined;
  // The conversation leaving the list, and where it was, until the selection has moved on from it.
  // Meanwhile it stays picked, and the moves either side of it and the reader's place count from
  // where it was, so the commands and what shows them don't change in the frame that shows it gone.
  const [vacating, setVacating] = useState<Vacating<ListItem>>();
  // Where each fetched conversation lies, so finding one never reads the whole list.
  const places = useMemo(
    () => (conversations ? placesOf(conversations) : NO_PLACES),
    [conversations],
  );
  const rowOf = useCallback(
    (id: ConversationId) => conversations?.[places.get(id) ?? -1],
    [conversations, places],
  );
  const placeOf = useCallback(
    (id: ConversationId | undefined) => placeAmong(places, vacating, id),
    [places, vacating],
  );
  const picked = useMemo(
    () => pickedIn(conversations, places, selection.ids, vacating),
    [conversations, places, selection.ids, vacating],
  );
  // The selection and whether the member is picking as they are now, which a refused triage puts
  // back, and the list's order, read only by a pick that adds to the selection or extends it.
  const now = useRef({ selection, isPicking });
  const order = useRef<Listed<ListItem>>([]);
  useLayoutEffect(() => {
    now.current = { selection, isPicking };
    order.current = conversations ?? [];
  });

  /**
   * A conversation that leaves the list gives way to the one below it, or above it at the end. The
   * list shows the conversation gone at once, and the reader turns to the next one just after, so
   * the frame that shows the archive doesn't wait for the next conversation to render.
   */
  const giveWay = (id: ConversationId): Selection => {
    const at = places.get(id) ?? -1;
    const leaving = conversations?.[at];
    if (!leaving) return selection;
    const next = conversations?.[at + 1] ?? conversations?.[at - 1];
    const left = selectOnly(next?.id);
    setVacating({ row: leaving, at });
    startTransition(() => {
      setSelection(left);
      setVacating(undefined);
    });
    return left;
  };
  /**
   * A triage the server refuses puts its rows back, so a selection it moved on to `left` comes back
   * too, as nothing happened, unless the member has moved it since. `putBack` restores what else
   * moved with it.
   */
  const backIfRefused = useCallback((left: Selection, putBack?: () => void) => {
    const before = now.current;
    return () => {
      if (!isSameSelection(now.current.selection, left)) return;
      setSelection(before.selection);
      setPicking(before.isPicking);
      putBack?.();
    };
  }, []);
  /** A pick in the list, in its order. */
  const selectBy = useCallback((id: ConversationId, by: SelectBy) => {
    setSelection((current) => select(current, id, by, by === 'only' ? [] : idsIn(order.current)));
  }, []);
  const startPicking = useCallback((id: ConversationId) => {
    setPicking(true);
    setSelection(selectOnly(id));
  }, []);
  /** Selects only this conversation, or nothing. */
  const only = useCallback((id: ConversationId | undefined) => setSelection(selectOnly(id)), []);
  /** Selects this conversation, unless the member has selected one of their own in the meantime. */
  const selectIfNone = useCallback((id: ConversationId) => {
    setSelection((current) => (current.ids.length > 0 ? current : selectOnly(id)));
  }, []);
  /** Selects nothing, and so ends picking, returning the selection it leaves. */
  const clear = useCallback(() => {
    setSelection(NOTHING_SELECTED);
    setPicking(false);
    return NOTHING_SELECTED;
  }, []);
  /** Selects nothing, while the row keys move from stays the one given. */
  const deselect = useCallback((active: ConversationId | undefined) => {
    setSelection(active === undefined ? NOTHING_SELECTED : { ids: [], active });
  }, []);
  /** A row that leaves, as a swipe takes it, leaves any selection that held it. */
  const releaseRow = useCallback((id: ConversationId) => {
    const { selection } = now.current;
    const left = selection.ids.includes(id) ? NOTHING_SELECTED : selection;
    setSelection(left);
    return left;
  }, []);
  return {
    selection,
    isPicking,
    /** The one conversation selected, if only one is. */
    selected,
    isMany: selection.ids.length > 1,
    vacating,
    places,
    rowOf,
    placeOf,
    /** The rows the selection picks, in the list's order. */
    picked,
    giveWay,
    backIfRefused,
    selectBy,
    selectOnly: only,
    selectIfNone,
    startPicking,
    clear,
    deselect,
    releaseRow,
  };
}
