import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationId } from '../../mail/core/index.ts';

/** How long a conversation its view opened stays open, while the page is visible, to count as read. */
export const DWELL_MS = 2_000;

/**
 * When a conversation the reader shows is marked read. One the member opened is read at once. One
 * that choosing its view opened is read only once it has stayed open {@link DWELL_MS} while the
 * page is visible, so passing through a view reads nothing, and moving on from it before then leaves
 * it unread. Hiding the page starts the wait over when it shows again.
 */
export function useReadMark({
  selected,
  markRead,
}: {
  selected: ConversationId | undefined;
  markRead: (id: ConversationId) => void;
}) {
  // The conversation its view opened, and whether the reader has drawn it yet, until the member
  // moves on from it or it's read.
  const [byView, setByView] = useState<{ id: ConversationId; isShown: boolean }>();
  if (byView && byView.id !== selected) setByView(undefined);
  // The callbacks read these, so they stay the same functions and what they're handed to doesn't
  // render again.
  const latest = useRef({ markRead, byView });
  useLayoutEffect(() => {
    latest.current = { markRead, byView };
  });

  useEffect(() => {
    if (!byView?.isShown) return;
    const { id } = byView;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        setByView(undefined);
        latest.current.markRead(id);
      }, DWELL_MS);
    };
    wait();
    document.addEventListener('visibilitychange', wait);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wait);
    };
  }, [byView]);

  /** The reader has drawn a conversation. */
  const onShown = useCallback((id: ConversationId) => {
    if (latest.current.byView?.id === id) setByView({ id, isShown: true });
    else latest.current.markRead(id);
  }, []);
  /** Choosing its view opened a conversation, in the same moment as it's selected. */
  const openedByView = useCallback((id: ConversationId) => setByView({ id, isShown: false }), []);
  /** The member opened a conversation, which reads one its view opened at once. */
  const openedByMember = useCallback((id: ConversationId) => {
    if (latest.current.byView?.id !== id) return;
    setByView(undefined);
    latest.current.markRead(id);
  }, []);
  return { onShown, openedByView, openedByMember };
}
