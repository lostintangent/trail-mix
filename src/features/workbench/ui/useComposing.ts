import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  sameRef,
  type Account,
  type ConversationId,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';
import type { Compose, Writing } from '../../composer/ui/index.ts';

/**
 * What the member is writing, if anything, and how writing starts and ends. A composer belongs to
 * the conversation open when it started, and opening another conversation closes it, which saves
 * what it holds. The drafts it has saved stay out of the reader: every draft that comes to its
 * conversation while the composer is open, which a hint can bring before the save that made it has
 * answered, and every one a later save replaced, which the server has dropped. The reader asks
 * which to leave out of the messages it is about to show, so it never draws one that came in the
 * same snapshot as the conversation.
 */
export function useComposing(selected: ConversationId | undefined, leaving: readonly MessageRef[]) {
  const queryClient = useQueryClient();
  // What is being written and the conversation it started in. Each start is a composer of its
  // own, even for a message like the one before.
  const [started, setStarted] = useState<{
    compose: Compose;
    in: ConversationId | undefined;
    session: number;
    /** The drafts its conversation held as it started, which the reader goes on showing. */
    before: readonly MessageRef[];
  }>();
  const [editing, setEditing] = useState<MessageRef>();
  const [replaced, setReplaced] = useState<readonly MessageRef[]>([]);
  const selectedNow = useRef(selected);
  useLayoutEffect(() => {
    selectedNow.current = selected;
  });
  const start = useCallback(
    (next: Compose | undefined) => {
      const opened = selectedNow.current;
      const before = (
        (opened !== undefined && queryClient.getQueryData(conversationQuery(opened).queryKey)) ||
        []
      ).filter(({ flags }) => flags.draft);
      setStarted(
        (was) => next && { compose: next, in: opened, session: (was?.session ?? 0) + 1, before },
      );
      setEditing(next?.as === 'draft' || next?.as === 'resumed' ? next.draft : undefined);
    },
    [queryClient],
  );
  // Opening another conversation closes the composer at once, and then forgets it, so coming back
  // doesn't open it again from where it began.
  const compose = started?.in === selected ? started?.compose : undefined;
  useEffect(() => {
    if (started && started.in !== selected) start(undefined);
  }, [started, selected, start]);
  const open = useRef<Compose>(undefined);
  useEffect(() => {
    open.current = compose;
  }, [compose]);

  const write = useCallback((account: Account) => start({ as: 'new', account }), [start]);
  /** Answers one message, its sender or everyone on it. */
  const replyTo = useCallback(
    (message: Message, all: boolean) => start({ as: 'reply', to: message, all }),
    [start],
  );
  /** Answers a conversation's newest message that isn't a draft. */
  const replyIn = useCallback(
    (conversation: readonly Message[], all: boolean) => {
      const parent = newestOf(conversation);
      if (parent) replyTo(parent, all);
    },
    [replyTo],
  );
  /**
   * Answers the selected conversation once its messages are at hand: within the key's own event
   * when they are, so the reply and the cursor in it are in the page before the next key, which is
   * then typed rather than taken as a command.
   */
  const reply = useCallback(
    async (all: boolean) => {
      if (selected === undefined) return;
      const query = conversationQuery(selected);
      replyIn(
        queryClient.getQueryData(query.queryKey) ?? (await queryClient.ensureQueryData(query)),
        all,
      );
    },
    [queryClient, selected, replyIn],
  );
  const openDraft = useCallback(
    (draft: Message, conversation: Message[]) => start({ as: 'draft', draft, conversation }),
    [start],
  );
  /** Brings back what was being written when a send of it was undone. */
  const resume = useCallback(
    (writing: Writing, draft: MessageRef, isDocked: boolean) =>
      start({ as: 'resumed', writing, draft, isDocked }),
    [start],
  );
  const close = useCallback(() => start(undefined), [start]);
  // A save can land after its composer has closed, and then only what it replaced matters.
  const noteDraft = useCallback(
    (from: Compose, saved: MessageRef, older: MessageRef | undefined) => {
      if (older) setReplaced((was) => [...was, older]);
      if (open.current === from) setEditing(saved);
    },
    [],
  );
  // Drafts on their way stay out too, since they can't be written on until their send is undone.
  const hiding = useMemo<Hiding>(
    () => ({
      writing: compose && started && { in: started.in, before: started.before, editing },
      gone: [...replaced, ...leaving],
    }),
    [compose, started, editing, replaced, leaving],
  );

  return {
    compose,
    session: started?.session ?? 0,
    write,
    reply,
    replyTo,
    replyIn,
    openDraft,
    resume,
    close,
    noteDraft,
    hiding,
  };
}

/**
 * What the reader leaves out while the member writes: the composer open, if any, with the
 * conversation it started in, the drafts that conversation held then and the draft it edits, and
 * the drafts gone from every conversation.
 */
export type Hiding = {
  writing?: {
    in: ConversationId | undefined;
    before: readonly MessageRef[];
    editing: MessageRef | undefined;
  };
  gone: readonly MessageRef[];
};

/**
 * The drafts the reader leaves out of a conversation's messages, decided from those very messages,
 * so a draft the composer saved is out of the first snapshot that holds it.
 */
export function hiddenIn(
  { writing, gone }: Hiding,
  id: ConversationId,
  conversation: readonly Message[],
): MessageRef[] {
  if (!writing) return [...gone];
  const written =
    writing.in === id
      ? conversation.filter(
          (message) =>
            message.flags.draft && !writing.before.some((draft) => sameRef(draft, message)),
        )
      : [];
  return [...gone, ...written, ...(writing.editing ? [writing.editing] : [])];
}

/** A conversation's newest message that isn't a draft, which its keys answer and show. */
export function newestOf(conversation: readonly Message[]): Message | undefined {
  return conversation
    .filter(({ flags }) => !flags.draft)
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .at(-1);
}
