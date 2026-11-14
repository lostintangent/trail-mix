import { useEffect, useRef, useState } from 'react';
import type { MessageRef } from '../../mail/core/index.ts';
import type { Attached, Writing } from '../core/session.ts';
import type { Drafting, SaveState } from './drafting.ts';

export type { SaveState };

/**
 * Shows a message being written in its composer: hands it what the member writes, owes a save for
 * each of their changes, saves what's owed when the page hides or the composer closes, and says how
 * its saves go. After each save, the files the composer carries are named by the parts of the saved
 * draft, through `onNamed`, so their bytes cross once.
 *
 * `edits` counts the member's changes. A save follows a change, never the composer's own updates.
 */
export function useAutosave({
  drafting,
  writing,
  edits,
  onDraft,
  onNamed,
}: {
  drafting: Drafting;
  writing: Writing;
  edits: number;
  onDraft: (saved: MessageRef, replaced: MessageRef | undefined) => void;
  onNamed: (named: Map<Attached, Attached>) => void;
}) {
  const [state, setState] = useState(drafting.state);
  const latest = useRef({ onDraft, onNamed });
  useEffect(() => {
    latest.current = { onDraft, onNamed };
    drafting.write(writing);
  });

  // A page that hides may never show again, and a composer that closes won't save later, so what
  // either owes is saved now.
  useEffect(() => {
    drafting.show({
      onState: setState,
      onDraft: (saved, replaced) => latest.current.onDraft(saved, replaced),
      onNamed: (named) => latest.current.onNamed(named),
    });
    setState(drafting.state);
    const hide = () => {
      if (document.visibilityState === 'hidden') drafting.hidden();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', hide);
      drafting.close();
    };
  }, [drafting]);

  const owed = useRef(0);
  useEffect(() => {
    if (edits === owed.current) return;
    owed.current = edits;
    drafting.owe();
  }, [edits, drafting]);

  /** Hands over what's written now, as Send does before the effects that would have. */
  const flush = () => {
    drafting.write(writing);
    if (edits === owed.current) return;
    owed.current = edits;
    drafting.owe();
  };

  return { state, flush };
}
