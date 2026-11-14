import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BundleId, ConversationId, Place, View } from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';

/**
 * The open conversation and the place, kept together. A change of view pushes the place, so Back
 * returns to it, except while a search is typed, which replaces it at each key. The selection
 * replaces it, so moving by key adds no history. A place the workbench didn't move to arrives from
 * outside, as a load, a link, Back and Forward bring one, and the workbench follows it, until the
 * member moves on. A place whose conversation has gone opens its view with nothing selected, or its
 * bundle with no thread.
 */
export function useSelectedPlace({
  place,
  onPlaceChange,
  bundle,
  open,
  isMany,
  arrive,
  close,
}: {
  place: Place;
  onPlaceChange: (place: Place, history: 'push' | 'replace') => void;
  /** The bundle selected, if one is. */
  bundle: BundleId | undefined;
  /** The one conversation open, selected or a thread of the bundle selected, if one is. */
  open: ConversationId | undefined;
  /** Whether several are, which the address leaves out. */
  isMany: boolean;
  /** Follows a place that arrived from outside. */
  arrive: (place: Place) => void;
  /** Closes the conversation open, as one gone from the server leaves nothing open. */
  close: () => void;
}) {
  const { view } = place;
  // The place this workbench last moved to, so one it didn't is known to have arrived.
  const moved = useRef(place);
  // What the selection last wrote, and what was last pushed, so the selection doesn't write back
  // a place it already holds.
  const written = useRef(place.open ?? place.bundle);
  const pushed = useRef<ConversationId>(undefined);
  // The place that came from outside, until the member moves on. The conversation it opens is
  // looked up, since it may have gone since the address was written.
  const [arrived, setArrived] = useState<Place | undefined>(place);
  const latest = useRef({ view, bundle, open, arrive, close });
  useLayoutEffect(() => {
    latest.current = { view, bundle, open, arrive, close };
  });
  const move = useCallback(
    (next: Place, history: 'push' | 'replace') => {
      moved.current = next;
      onPlaceChange(next, history);
    },
    [onPlaceChange],
  );

  useEffect(() => {
    if (place === moved.current) return;
    moved.current = place;
    written.current = place.open ?? place.bundle;
    setArrived(place);
    latest.current.arrive(place);
  }, [place]);

  // Only a change of selection moves the place, not the place moving under a selection that hasn't
  // followed it yet.
  const at = open ?? bundle;
  useEffect(() => {
    if (isMany || at === written.current) return;
    written.current = at;
    setArrived(undefined);
    const { view, bundle, open } = latest.current;
    move(placeIn(view, bundle, open), 'replace');
  }, [isMany, at, move]);

  const opens = arrived?.open;
  const { data: shown } = useQuery({
    ...conversationQuery(opens ?? ''),
    enabled: opens !== undefined,
  });
  useEffect(() => {
    if (opens === undefined || shown === undefined || shown.length > 0) return;
    setArrived(undefined);
    // The member may have moved on already, as archiving it does.
    const { view, bundle, open } = latest.current;
    if (open !== opens) return;
    written.current = bundle;
    latest.current.close();
    move(placeIn(view, bundle, undefined), 'replace');
  }, [opens, shown, move]);

  // The view changes under the open conversation, as a search typed or a folder renamed changes it.
  // A filter turned on or off takes the place of the view it filters.
  const onViewChange = useCallback(
    (next: View, history?: 'push' | 'replace') => {
      const { view, bundle, open } = latest.current;
      move(placeIn(next, bundle, open), history ?? historyFrom(view));
    },
    [move],
  );
  // The member chooses a view, which opens with nothing open, until its newest fills it.
  const chooseView = useCallback(
    (next: View) => {
      written.current = undefined;
      setArrived(undefined);
      move({ view: next }, historyFrom(latest.current.view));
    },
    [move],
  );
  // A search typed or a filter turned on makes a view of its own, which the place didn't name.
  const isArrived = arrived?.view === view;
  return { move, onViewChange, chooseView, written, pushed, isArrived };
}

/** The place of a view, with the bundle and the conversation open in it, if any. */
const placeIn = (
  view: View,
  bundle: BundleId | undefined,
  open: ConversationId | undefined,
): Place => ({
  view,
  ...(bundle === undefined ? {} : { bundle }),
  ...(open === undefined ? {} : { open }),
});

/** A step to a new view is pushed, so Back returns, except from a search, which it takes the place of. */
const historyFrom = (view: View) => (view.in === 'search' ? 'replace' : 'push');
