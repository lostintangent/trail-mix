import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, ConversationId, Message, MessageRef } from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';
import type { Compose } from '../../composer/ui/index.ts';

/**
 * What the member is writing, if anything, and how writing starts and ends. A composer belongs to
 * the conversation open when it started, and opening another conversation closes it, which saves
 * what it holds. The drafts it has saved stay out of the reader: the one being written while the
 * composer is open, and every one a later save replaced, which the server has dropped.
 */
export function useComposing(selected: ConversationId | undefined) {
  const queryClient = useQueryClient();
  const [compose, setCompose] = useState<Compose>();
  const [editing, setEditing] = useState<MessageRef>();
  const [replaced, setReplaced] = useState<readonly MessageRef[]>([]);
  // Each start is a composer of its own, even for a message like the one before.
  const [session, setSession] = useState(0);
  const open = useRef<Compose>(undefined);
  useEffect(() => {
    open.current = compose;
  }, [compose]);
  const start = useCallback((next: Compose | undefined) => {
    setCompose(next);
    setEditing(next?.as === 'draft' ? next.draft : undefined);
    if (next) setSession((count) => count + 1);
  }, []);

  const [startedIn, setStartedIn] = useState(selected);
  if (startedIn !== selected) {
    setStartedIn(selected);
    if (compose) start(undefined);
  }

  const write = useCallback((account: Account) => start({ as: 'new', account }), [start]);
  /** Answers a conversation's newest message that isn't a draft. */
  const replyIn = useCallback(
    (conversation: readonly Message[], all: boolean) => {
      const parent = conversation
        .filter(({ flags }) => !flags.draft)
        .toSorted((a, b) => a.date.localeCompare(b.date))
        .at(-1);
      if (parent) start({ as: 'reply', to: parent, all });
    },
    [start],
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
  const close = useCallback(() => start(undefined), [start]);
  // A save can land after its composer has closed, and then only what it replaced matters.
  const noteDraft = useCallback(
    (from: Compose, saved: MessageRef, older: MessageRef | undefined) => {
      if (older) setReplaced((was) => [...was, older]);
      if (open.current === from) setEditing(saved);
    },
    [],
  );
  const hidden = useMemo(
    () => (editing && compose ? [...replaced, editing] : replaced),
    [editing, compose, replaced],
  );

  return { compose, session, write, reply, replyIn, openDraft, close, noteDraft, hidden };
}

/** Whether a composer lies under the conversation it answers, rather than filling the reader. */
export function isDocked(compose: Compose): boolean {
  switch (compose.as) {
    case 'new':
      return false;
    case 'reply':
      return true;
    case 'draft':
      return compose.conversation.some(({ flags }) => !flags.draft);
  }
}
