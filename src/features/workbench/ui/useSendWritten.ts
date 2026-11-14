import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { toast } from '../../../shared/toasts.tsx';
import type { ConversationId, MessageRef } from '../../mail/core/index.ts';
import { isDocked, type Drafting, type Sender, type Writing } from '../../composer/ui/index.ts';
import { useSend, useSendCommands, type LeavingSends } from '../../outbox/index.ts';
import { leftBySend, type useComposing } from './useComposing.ts';

/**
 * Send closes the composer at once and hands what it holds to the Mailroom, carrying its last save.
 * Undo, or a send that fails, brings the same message back, under its conversation if that's still
 * the one open, unless another composer has opened meanwhile, when a failure's toast offers to open
 * it. With no network nothing can be sent, and writing offline is out of scope, so Send and Send
 * later wait, and the composer says why.
 */
export function useSendWritten({
  composing,
  leaving,
  opened,
  isDraftsList,
  isOnline,
  onLeft,
}: {
  composing: ReturnType<typeof useComposing>;
  leaving: LeavingSends;
  /** The conversation open in the reader. */
  opened: ConversationId | undefined;
  /** Whether the list is of drafts, which a conversation leaves once its drafts are all sent. */
  isDraftsList: boolean;
  isOnline: boolean;
  /** A conversation the send leaves with nothing to show gives way, as one archived does. */
  onLeft: (conversation: ConversationId) => void;
}) {
  const { compose } = composing;
  const send = useSend();
  const sender = useRef<Sender['current']>(undefined);
  const [isSendable, setSendable] = useState(false);
  const shownNow = useRef(opened);
  const composeNow = useRef(compose);
  useLayoutEffect(() => {
    shownNow.current = opened;
    composeNow.current = compose;
  });
  // A reply is on its way at the end of its conversation in the frame its composer closes, as is a
  // draft opened in its own, and leaves it again if the send fails or Undo takes it back. A new
  // message has no conversation until the Outbox names one.
  const onSend = (drafting: Drafting, at: string | undefined, writing: Writing) => {
    // Before the composer closes, which would save what it owes.
    drafting.hand();
    const from = { conversation: opened, isDocked: compose !== undefined && isDocked(compose) };
    const left = leftBySend(compose, opened, isDraftsList, leaving.all);
    if (left !== undefined) onLeft(left);
    const id = crypto.randomUUID();
    const pressedAt = Date.now();
    // Whom it goes to, as the Outbox will say: everyone it names but Bcc.
    const to = [...writing.to, ...writing.cc];
    leaving.pressed(id, {
      draft: drafting.draft,
      in: from.isDocked
        ? from.conversation
        : compose?.as === 'draft'
          ? compose.draft.conversation
          : undefined,
      written: writing.markdown,
      to,
      at,
      pressedAt,
    });
    composing.sent(id);
    const unwatch = drafting.watch((saved) => leaving.named(id, saved));
    // Until the Mailroom has the send, the drafts it makes are the leaving’s, and stay out of sight.
    const handed = (draft: MessageRef | undefined) => {
      if (draft) drafting.took(draft);
      unwatch();
      composing.saved(id);
    };
    const back = () => {
      leaving.forgotten(id);
      composing.resume(drafting, from.isDocked && shownNow.current === from.conversation);
    };
    send({
      id,
      last: (signal, onUnreached) => drafting.last(signal, onUnreached),
      to,
      at,
      pressedAt,
      onSent: handed,
      onUndone: (draft) => {
        handed(draft);
        drafting.resume();
        back();
      },
      onFailed: (reason) => {
        handed(undefined);
        drafting.resume();
        const body = `Couldn’t send. ${reason}`;
        if (composeNow.current === undefined) {
          back();
          void toast({ type: 'error', body });
          return;
        }
        leaving.forgotten(id);
        void toast({ type: 'error', body, action: { label: 'Open', onAction: back } });
      },
    });
  };
  /** Sends what the open composer holds, at a time or now, as its own Send would. */
  const sendAt = useCallback((at?: string) => sender.current?.(at), []);
  const commands = useSendCommands(compose !== undefined, {
    onSend: sendAt,
    isEnabled: isSendable && isOnline,
    shortcut: 'Mod+Enter',
  });
  return { onSend, sender, onSendable: setSendable, sendAt, commands };
}
