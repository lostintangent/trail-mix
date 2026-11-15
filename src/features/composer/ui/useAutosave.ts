import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import type { Drafting, Showing } from './drafting.ts';

/**
 * Shows a message being written in its composer: saves what's owed when the page hides or the
 * composer closes, and says how its saves go.
 */
export function useAutosave(drafting: Drafting, onDraft: Showing['onDraft']) {
  const draftTaken = useEffectEvent(onDraft);
  // A page that hides may never show again, and a composer that closes won't save later, so what
  // either owes is saved now.
  useEffect(() => {
    drafting.show({ onDraft: (saved, replaced) => draftTaken(saved, replaced) });
    const hide = () => {
      if (document.visibilityState === 'hidden') drafting.hidden();
    };
    document.addEventListener('visibilitychange', hide);
    // A page that goes is still visible as it does, and Safari may close a tab without hiding it.
    window.addEventListener('pagehide', drafting.hidden);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', drafting.hidden);
      drafting.close();
    };
  }, [drafting]);
  return useSyncExternalStore(drafting.subscribe, () => drafting.state);
}
