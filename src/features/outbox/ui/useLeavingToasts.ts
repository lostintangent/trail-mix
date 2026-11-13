import { useEffect, useRef } from 'react';
import type { ConversationId } from '../../mail/core/index.ts';
import { toastFor, type Leaving } from '../core/leaving.ts';
import { isAsked, useAskedVersion } from './asked.ts';
import { loadSending } from './useSend.ts';

/**
 * Shows and puts away the toasts that follow the sends this device asked for, as the member moves:
 * none while they're on a send's conversation, whose line there says it all, and one while they're
 * elsewhere. `shown` is the conversation on screen, if any is.
 */
export function useLeavingToasts(all: readonly Leaving[], shown: ConversationId | undefined) {
  const asked = useAskedVersion();
  const known = useRef(new Set<string>());
  const was = useRef(shown);
  useEffect(() => {
    const hasMoved = was.current !== shown;
    was.current = shown;
    const now = Date.now();
    for (const leaving of all) {
      const { seen } = leaving;
      if (!seen || !isAsked(seen.last.id)) continue;
      const isFirstSight = !known.current.has(seen.last.id);
      if (!isFirstSight && !hasMoved) continue;
      known.current.add(seen.last.id);
      const doing = toastFor(leaving, shown, isFirstSight, now);
      if (doing === 'stay') continue;
      void loadSending().then((sending) =>
        doing === 'show'
          ? sending.showLeavingToast(seen, leaving.closes)
          : sending.putAwayLeavingToast(seen.last.id),
      );
    }
  }, [all, shown, asked]);
}
