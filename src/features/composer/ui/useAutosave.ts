import { useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../../shared/toasts.tsx';
import type { MessageRef } from '../../mail/core/index.ts';
import { bodyQuery, mailroom } from '../../mailroom/client/index.ts';
import {
  afterSave,
  draftInputOf,
  SAVE_AFTER_MS,
  SAVE_AT_LEAST_EVERY_MS,
  type Attached,
  type Writing,
} from '../core/session.ts';

/** How long after a save fails it is tried again. */
const RETRY_AFTER_MS = 5_000;

/** How many more times a composer that has closed tries its last save. */
const RETRIES_ONCE_CLOSED = 2;

export type SaveState = 'unsaved' | 'saving' | 'saved' | 'failed';

/**
 * Saves what the member writes to the account's Drafts, shortly after typing pauses, at least every
 * few seconds while it doesn't, whenever the page hides, and when the composer goes away. One save
 * runs at a time, each replacing the draft the one before saved, and a change made during a save is
 * saved after it. After each save, the files the composer carries are named by the parts of the
 * saved draft, through `onSaved`, so their bytes cross once.
 *
 * `edits` counts the member's changes. A save follows a change, never the composer's own updates.
 */
export function useAutosave({
  writing,
  edits,
  draft: startingDraft,
  onSaved,
}: {
  writing: Writing;
  edits: number;
  draft: MessageRef | undefined;
  onSaved: (
    saved: MessageRef,
    replaced: MessageRef | undefined,
    named: Map<Attached, Attached>,
  ) => void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState>(startingDraft ? 'saved' : 'unsaved');
  const session = useRef({
    draft: startingDraft,
    writing,
    isOwed: false,
    owedSince: 0,
    isDiscarded: false,
    hasFailed: false,
    isClosed: false,
    retriesClosed: 0,
    saving: undefined as Promise<void> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const latestSaved = useRef(onSaved);
  useEffect(() => {
    latestSaved.current = onSaved;
    session.current.writing = writing;
  });

  const save = useCallback((): Promise<void> => {
    const current = session.current;
    clearTimeout(current.timer);
    current.timer = undefined;
    if (current.saving || current.isDiscarded) return current.saving ?? Promise.resolve();
    current.isOwed = false;
    setState('saving');
    const writing = current.writing;
    const run = async () => {
      const older = current.draft;
      // A draft replaces only one from its own account, so one moved to another account is saved
      // anew and the old one goes to the Trash.
      const replaces = older?.account === writing.account ? older : undefined;
      try {
        const saved = await mailroom.saveDraft(draftInputOf(writing), replaces);
        current.draft = saved;
        if (older && !replaces) await mailroom.move([older], 'trash').catch(() => {});
        const body = await queryClient.fetchQuery(bodyQuery(saved));
        const named = afterSave(writing.attachments, saved, body);
        latestSaved.current(
          saved,
          older,
          new Map(writing.attachments.map((file, at) => [file, named[at]!])),
        );
        current.hasFailed = false;
        setState(current.isOwed ? 'unsaved' : 'saved');
      } catch {
        current.hasFailed = true;
        current.isOwed = true;
        setState('failed');
        // A closed composer tries its last save a few more times, then gives up.
        if (!current.isClosed || ++current.retriesClosed <= RETRIES_ONCE_CLOSED) {
          current.timer = setTimeout(() => void save(), RETRY_AFTER_MS);
        }
      } finally {
        current.saving = undefined;
      }
      if (current.isOwed && current.timer === undefined) {
        current.timer = setTimeout(() => void save(), owedWait(current.owedSince));
      }
    };
    current.saving = run();
    return current.saving;
  }, [queryClient]);

  // A change owes a save: shortly after typing pauses, and at least every few seconds meanwhile.
  const schedule = useCallback(() => {
    const current = session.current;
    if (current.saving || current.isDiscarded) return;
    clearTimeout(current.timer);
    current.timer = setTimeout(() => void save(), owedWait(current.owedSince));
  }, [save]);

  useEffect(() => {
    if (edits === 0) return;
    const current = session.current;
    if (!current.isOwed) current.owedSince = performance.now();
    current.isOwed = true;
    setState((was) => (was === 'saving' ? was : 'unsaved'));
    schedule();
  }, [edits, schedule]);

  // A page that hides may never show again, and a composer that closes won't save later, so what
  // either owes is saved now.
  useEffect(() => {
    const current = session.current;
    const hide = () => {
      if (document.visibilityState === 'hidden' && current.isOwed) void save();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', hide);
      current.isClosed = true;
      if (current.isOwed) void (current.saving ? current.saving.then(save) : save());
    };
  }, [save]);

  /** The draft once everything written is saved, as Send needs it, saving one if there's none. */
  const settle = useCallback(async (): Promise<MessageRef> => {
    const current = session.current;
    if (!current.draft) current.isOwed = true;
    while (current.saving || current.isOwed) {
      await (current.saving ?? save());
      if (current.hasFailed) throw new Error('The draft couldn’t be saved.');
    }
    if (!current.draft) throw new Error('The draft couldn’t be saved.');
    return current.draft;
  }, [save]);

  /**
   * Stops saving and moves the draft to the Trash, once any save under way has made it, with a way
   * to bring it back.
   */
  const discard = useCallback(async () => {
    const current = session.current;
    current.isDiscarded = true;
    clearTimeout(current.timer);
    await current.saving;
    if (!current.draft) return;
    const moved = await mailroom.move([current.draft], 'trash').catch(() => undefined);
    if (!moved) {
      void toast({ type: 'error', body: 'Couldn’t discard the draft. It is still in Drafts.' });
      return;
    }
    void toast({
      body: 'Draft discarded',
      action: {
        label: 'Undo',
        icon: Undo2,
        onAction: () =>
          void mailroom.move(
            moved.map(({ to }) => to),
            'drafts',
          ),
      },
    });
  }, []);

  return { state, settle, discard };
}

/** How long a save owed since `owedSince` waits: for typing to pause, but never past the longest. */
function owedWait(owedSince: number): number {
  return Math.max(
    0,
    Math.min(SAVE_AFTER_MS, owedSince + SAVE_AT_LEAST_EVERY_MS - performance.now()),
  );
}
