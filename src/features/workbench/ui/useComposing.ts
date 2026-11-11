import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Account, ConversationId, Message, MessageRef } from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';
import type { Compose, Writing } from '../../composer/ui/index.ts';

/**
 * What the member is writing, if anything, and how writing starts and ends. A composer belongs to
 * the conversation open when it started, and opening another conversation closes it, which saves
 * what it holds. The drafts it has saved stay out of the reader: the one being written while the
 * composer is open, and every one a later save replaced, which the server has dropped.
 */
export function useComposing(selected: ConversationId | undefined, leaving: readonly MessageRef[]) {
  const queryClient = useQueryClient();
  // What is being written and the conversation it started in. Each start is a composer of its
  // own, even for a message like the one before.
  const [started, setStarted] = useState<{
    compose: Compose;
    in: ConversationId | undefined;
    session: number;
  }>();
  const [editing, setEditing] = useState<MessageRef>();
  const [replaced, setReplaced] = useState<readonly MessageRef[]>([]);
  const selectedNow = useRef(selected);
  useLayoutEffect(() => {
    selectedNow.current = selected;
  });
  const start = useCallback((next: Compose | undefined) => {
    setStarted(
      (was) => next && { compose: next, in: selectedNow.current, session: (was?.session ?? 0) + 1 },
    );
    setEditing(next?.as === 'draft' || next?.as === 'resumed' ? next.draft : undefined);
  }, []);
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
  /** Answers the selected conversation, once its messages are at hand. */
  const reply = useCallback(
    async (all: boolean) => {
      if (selected === undefined) return;
      replyIn(await queryClient.ensureQueryData(conversationQuery(selected)), all);
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
  const hidden = useMemo(
    () => [...replaced, ...leaving, ...(editing && compose ? [editing] : [])],
    [editing, compose, replaced, leaving],
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
    hidden,
  };
}

/** A conversation's newest message that isn't a draft, which its keys answer and show. */
export function newestOf(conversation: readonly Message[]): Message | undefined {
  return conversation
    .filter(({ flags }) => !flags.draft)
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .at(-1);
}
