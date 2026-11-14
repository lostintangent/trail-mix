import type { QueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { toast } from '../../../shared/toasts.tsx';
import { sameRef, type MessageRef } from '../../mail/core/index.ts';
import { bodyQuery, mailroom, untilAnswered, type LastSave } from '../../mailroom/client/index.ts';
import {
  afterSave,
  draftInputOf,
  SAVE_AFTER_MS,
  SAVE_AT_LEAST_EVERY_MS,
  type Attached,
  type DraftInput,
  type Writing,
} from '../core/session.ts';

/** How long after the Mailroom refuses a save a new one is tried. */
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
 * a save is saved after it. A save is asked under an id of its own until the Mailroom answers or
 * refuses it, so one whose answer was lost files one copy however often it's asked. It outlives its
 * composer, so Send closes the composer at once and carries its last save to the Mailroom, and Undo
 * brings the same message back to a composer.
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
  /** Send has it: no save starts until Send gives it back, since Send carries the last save itself. */
  hand: () => void;
  /**
   * What Send sends, once any save on its way has answered: the draft, if it holds everything
   * written, or else the last save, which the Mailroom files as it schedules the send. Stops
   * waiting once `signal` aborts. While that save has gone unanswered for a while, `onUnreached`
   * hears what failed each time.
   */
  last: (
    signal: AbortSignal,
    onUnreached: (error: unknown) => void,
  ) => Promise<MessageRef | LastSave>;
  /** The draft the Mailroom filed the last save Send carried as, or the one it sent. */
  took: (saved: MessageRef) => void;
  /**
   * Send gave it back, undone or failed. The files a save it carried held take their names in the
   * draft that save was filed as, before anything saves them again, and what's owed is saved.
   */
  resume: () => void;
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
  let isHanded = false;
  let isClosed = false;
  let retriesClosed = 0;
  let saving: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // What failed when the save under way last went unanswered, once it has for a while, and the
  // Sends waiting for it, which hear of each.
  let unreached: { error: unknown } | undefined;
  const hearing = new Set<(error: unknown) => void>();
  // The files the save Send carries held, until they are named by the draft it was filed as. Their
  // old names may be of a draft that filing replaced, whose bytes the Mailroom lets go.
  let carried: readonly Attached[] | undefined;
  let unnamed: { made: MessageRef; attachments: readonly Attached[] } | undefined;
  // The names they took, for a composer that started from what was written before they did.
  let named: Map<Attached, Attached> | undefined;

  const become = (next: SaveState) => {
    state = next;
    showing?.onState(next);
  };

  /** One step of saving at a time, which the next waits for, then a save of what came meanwhile. */
  const step = (run: () => Promise<void>): Promise<void> => {
    saving = run().finally(() => {
      saving = undefined;
      if (isOwed && timer === undefined) timer = setTimeout(() => void save(), owedWait(owedSince));
    });
    return saving;
  };

  const save = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (saving || isDiscarded || isHanded) return saving ?? Promise.resolve();
    isOwed = false;
    become('saving');
    let saved = writing;
    return step(async () => {
      try {
        // Files still named by a draft a carried save replaced are named anew first, and what was
        // written meanwhile is saved with them.
        if (unnamed) {
          await nameCarried();
          isOwed = false;
          saved = writing;
        }
        const older = draft;
        // A draft replaces only one from its own account, so one moved to another account is saved
        // anew and the old one goes to the Trash.
        const replaces = older?.account === saved.account ? older : undefined;
        const made = await file(draftInputOf(saved), replaces);
        draft = made;
        showing?.onDraft(made, older);
        for (const watcher of watchers) watcher(made);
        if (older && !replaces) await mailroom.move([older], 'trash').catch(() => {});
        await rename(saved.attachments, made);
        become(isOwed ? 'unsaved' : 'saved');
      } catch {
        isOwed = true;
        become('failed');
        // A closed composer's message tries its last save a few more times, then gives up.
        if (!isClosed || ++retriesClosed <= RETRIES_ONCE_CLOSED) {
          timer = setTimeout(() => void save(), RETRY_AFTER_MS);
        }
      }
    });
  };

  /**
   * Asks the Mailroom to file a save until it answers, under an id of the save's own, with which an
   * ask after one whose answer was lost finds the copy that one filed rather than filing another.
   * So nothing newer saves until it's answered or refused. Each ask that fails says so.
   */
  const file = async (save: DraftInput, replaces: MessageRef | undefined) => {
    const id = crypto.randomUUID();
    let asks = 0;
    try {
      return await untilAnswered(
        () =>
          mailroom.saveDraft(save, replaces, id, asks++ > 0).catch((error: unknown) => {
            become('failed');
            throw error;
          }),
        {
          onUnreached: (error) => {
            unreached = { error };
            for (const hear of hearing) hear(error);
          },
        },
      );
    } finally {
      unreached = undefined;
    }
  };

  /**
   * Names files as they were when saved, `attachments`, by the parts of the draft `made` that hold
   * them, so their bytes cross once, and tells the composer showing them.
   */
  const rename = async (attachments: readonly Attached[], made: MessageRef) => {
    const body = await queryClient.fetchQuery(bodyQuery(made));
    const fresh = afterSave(attachments, made, body);
    const names = new Map(attachments.map((file, at) => [file, fresh[at]!]));
    writing = {
      ...writing,
      attachments: writing.attachments.map((attached) => names.get(attached) ?? attached),
    };
    showing?.onNamed(names);
    return names;
  };

  const nameCarried = async () => {
    if (!unnamed) return;
    const { made, attachments } = unnamed;
    named = await rename(attachments, made);
    unnamed = undefined;
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
      if (named) next.onNamed(named);
      named = undefined;
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
      // A save that failed says so until another starts.
      if (state !== 'saving' && state !== 'failed') become('unsaved');
      // A change owes a save: shortly after typing pauses, and at least every few seconds meanwhile.
      if (saving || isDiscarded || isHanded) return;
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
    hand: () => {
      isHanded = true;
      clearTimeout(timer);
      timer = undefined;
    },
    last: async (signal, onUnreached) => {
      carried = undefined;
      if (unreached) onUnreached(unreached.error);
      hearing.add(onUnreached);
      try {
        while (saving) await saving;
      } finally {
        hearing.delete(onUnreached);
      }
      signal.throwIfAborted();
      if (draft && !isOwed) return draft;
      await nameCarried();
      signal.throwIfAborted();
      carried = writing.attachments;
      // A draft replaces only one from its own account, as a save's does.
      const replaces = draft?.account === writing.account ? draft : undefined;
      return { save: draftInputOf(writing), ...(replaces ? { replaces } : {}) };
    },
    took: (saved) => {
      const older = draft;
      draft = saved;
      isOwed = false;
      become('saved');
      if (older && sameRef(older, saved)) return;
      if (carried) unnamed = { made: saved, attachments: carried };
      carried = undefined;
      showing?.onDraft(saved, older);
      for (const watcher of watchers) watcher(saved);
      if (older && older.account !== saved.account) {
        void mailroom.move([older], 'trash').catch(() => {});
      }
    },
    resume: () => {
      isHanded = false;
      if (isOwed) void save();
      // One that fails leaves them to the next save, which names them first.
      else if (unnamed && !saving) void step(() => nameCarried().catch(() => {}));
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
