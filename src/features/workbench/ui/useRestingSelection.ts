import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationId } from '../../mail/core/index.ts';
import { REST_MS } from '../../reader/index.ts';

/**
 * The selection the reader shows, and whether the selection is passing it by. One made after a rest
 * shows at once. While the member moves quickly, as when holding a key, the reader waits until the
 * selection rests, so it does no work nobody would see, and the list keeps up.
 *
 * Only a move that doesn't rest passes the conversation shown by. The selection's own commit leaves
 * the reader as it was, so a move that rests turns it to the next conversation directly.
 *
 * A move is timed by the press that made it, not by when it was drawn, so on a slow phone a render
 * that runs long can't make quick presses look like rests.
 */
export function useRestingSelection(selected: ConversationId | undefined) {
  const [shown, setShown] = useState(selected);
  const [isPassing, setPassing] = useState(false);
  const pressedAt = useLastPress();
  // When the selection last moved between conversations, the press the last move used, and what
  // it moved from.
  const movedAt = useRef(-Infinity);
  const usedPress = useRef(-Infinity);
  const movedFrom = useRef(selected);
  useLayoutEffect(() => {
    const isPressed = pressedAt.current > usedPress.current;
    const at = isPressed ? pressedAt.current : performance.now();
    usedPress.current = pressedAt.current;
    // Resting matters between conversations, which keys pass by. A move to none or from none, as
    // choosing a view and opening its newest make, shows at once, and only a move to a conversation
    // that a press or a step between conversations made starts a rest.
    const isBetween = movedFrom.current !== undefined && selected !== undefined;
    const hasRested = !isBetween || at - movedAt.current >= REST_MS;
    if (selected !== undefined && (isPressed || isBetween)) movedAt.current = at;
    movedFrom.current = selected;
    const show = () => {
      setShown(selected);
      setPassing(false);
    };
    if (hasRested) {
      show();
      return;
    }
    setPassing(true);
    const timer = setTimeout(show, REST_MS);
    return () => clearTimeout(timer);
  }, [selected, pressedAt]);
  return { shown, isPassing: isPassing && shown !== selected };
}

/** When the member last pressed a key or a pointer, as the event says, however late it ran. */
function useLastPress() {
  const pressedAt = useRef(-Infinity);
  useEffect(() => {
    const note = (event: Event) => {
      pressedAt.current = event.timeStamp;
    };
    window.addEventListener('keydown', note, { capture: true });
    window.addEventListener('pointerdown', note, { capture: true });
    return () => {
      window.removeEventListener('keydown', note, { capture: true });
      window.removeEventListener('pointerdown', note, { capture: true });
    };
  }, []);
  return pressedAt;
}
