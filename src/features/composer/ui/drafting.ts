import type { QueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
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

/** How many more times a message whose composer has closed tries its last save. */
const RETRIES_ONCE_CLOSED = 2;

export type SaveState = 'unsaved' | 'saving' | 'saved' | 'failed';

/** What the composer showing a message hears of its saves. */
export type Showing = {
  onState: (state: SaveState) => void;
  /** Each draft a save makes, and the one it replaced, as soon as the Mailroom answers. */
  onDraft: (saved: MessageRef, replaced: MessageRef | undefined) => void;
  /** The files it carries, named by the parts of the draft saved, so their bytes cross once. */
  onNamed: (named: Map<Attached, Attached>) => void;
};

/**
 * A message being written, saved to the account's Drafts as it is: shortly after typing pauses, at
 * least every few seconds while it doesn't, whenever the page hides, and when its composer closes.
 * One save runs at a time, each replacing the draft the one before saved, and a change made during
 * a save is saved after it. It outlives its composer, so Send closes the composer at once while the
 * last save finishes behind it, and Undo brings the same message back to a composer.
 */
export type Drafting = {
  /** The draft it was last saved as, if it has been. */
  readonly draft: MessageRef | undefined;
  /** What was last written in it. */
  readonly writing: Writing;
  readonly state: SaveState;
  /** A composer shows it, and hears of its saves until another does. */
  show: (showing: Showing) => void;
  /** Hears of each draft a save makes, until it stops. */
  watch: (watcher: (saved: MessageRef) => void) => () => void;
  /** What the composer holds now, which the next save saves. */
  write: (writing: Writing) => void;
  /** A change of the member's, which owes a save. */
  owe: () => void;
  /** The page hides, and may never show again, so what's owed is saved now. */
  hidden: () => void;
  /** Its composer closes, and won't save later, so what's owed is saved now. */
  close: () => void;
  /**
   * The draft once everything written is saved, as Send needs it, saving one if there's none. It
   * fails with the reason a save failed, and stops waiting once `signal` aborts.
   */
  settle: (signal?: AbortSignal) => Promise<MessageRef>;
  /**
   * Stops saving and moves the draft to the Trash, once any save under way has made it, with a way
   * to bring it back.
   */
  discard: () => Promise<void>;
};

export function startDrafting(
  queryClient: QueryClient,
  start: { draft: MessageRef | undefined; writing: Writing },
): Drafting {
  let { draft, writing } = start;
  let state: SaveState = draft ? 'saved' : 'unsaved';
  let showing: Showing | undefined;
  const watchers = new Set<(saved: MessageRef) => void>();
  let isOwed = false;
  let owedSince = 0;
  let isDiscarded = false;
  let failure: { reason: unknown } | undefined;
  let isClosed = false;
  let retriesClosed = 0;
  let saving: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const become = (next: SaveState) => {
    state = next;
    showing?.onState(next);
  };

  const save = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (saving || isDiscarded) return saving ?? Promise.resolve();
    isOwed = false;
    become('saving');
    const saved = writing;
    const run = async () => {
      const older = draft;
      // A draft replaces only one from its own account, so one moved to another account is saved
      // anew and the old one goes to the Trash.
      const replaces = older?.account === saved.account ? older : undefined;
      try {
        const made = await mailroom.saveDraft(draftInputOf(saved), replaces);
        draft = made;
        showing?.onDraft(made, older);
        for (const watcher of watchers) watcher(made);
        if (older && !replaces) await mailroom.move([older], 'trash').catch(() => {});
        const body = await queryClient.fetchQuery(bodyQuery(made));
        const named = afterSave(saved.attachments, made, body);
        const names = new Map(saved.attachments.map((file, at) => [file, named[at]!]));
        writing = {
          ...writing,
          attachments: writing.attachments.map((attached) => names.get(attached) ?? attached),
        };
        showing?.onNamed(names);
        failure = undefined;
        become(isOwed ? 'unsaved' : 'saved');
      } catch (reason) {
        failure = { reason };
        isOwed = true;
        become('failed');
        // A closed composer's message tries its last save a few more times, then gives up.
        if (!isClosed || ++retriesClosed <= RETRIES_ONCE_CLOSED) {
          timer = setTimeout(() => void save(), RETRY_AFTER_MS);
        }
      } finally {
        saving = undefined;
      }
      if (isOwed && timer === undefined) timer = setTimeout(() => void save(), owedWait(owedSince));
    };
    saving = run();
    return saving;
  };

  return {
    get draft() {
      return draft;
    },
    get writing() {
      return writing;
    },
    get state() {
      return state;
    },
    show: (next) => {
      showing = next;
      isClosed = false;
      retriesClosed = 0;
    },
    watch: (watcher) => {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    write: (next) => {
      writing = next;
    },
    owe: () => {
      if (!isOwed) owedSince = performance.now();
      isOwed = true;
      if (state !== 'saving') become('unsaved');
      // A change owes a save: shortly after typing pauses, and at least every few seconds meanwhile.
      if (saving || isDiscarded) return;
      clearTimeout(timer);
      timer = setTimeout(() => void save(), owedWait(owedSince));
    },
    hidden: () => {
      if (isOwed) void save();
    },
    close: () => {
      isClosed = true;
      if (isOwed) void (saving ? saving.then(save) : save());
    },
    settle: async (signal) => {
      if (!draft) isOwed = true;
      while (saving || isOwed) {
        if (signal?.aborted) throw signal.reason;
        await (saving ?? save());
        if (failure) throw failure.reason;
      }
      if (signal?.aborted) throw signal.reason;
      if (!draft) throw new Error('The draft couldn’t be saved.');
      return draft;
    },
    discard: async () => {
      isDiscarded = true;
      clearTimeout(timer);
      await saving;
      if (!draft) return;
      const moved = await mailroom.move([draft], 'trash').catch(() => undefined);
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
    },
  };
}

/** How long a save owed since `owedSince` waits: for typing to pause, but never past the longest. */
function owedWait(owedSince: number): number {
  return Math.max(
    0,
    Math.min(SAVE_AFTER_MS, owedSince + SAVE_AT_LEAST_EVERY_MS - performance.now()),
  );
}
