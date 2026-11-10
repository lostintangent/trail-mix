import { useQuery } from '@tanstack/react-query';
import type { MessageRef } from '../../mail/core/index.ts';
import { outboxQuery } from '../../mailroom/client/index.ts';
import { isOnItsWay, sendCommands } from './sendCommands.ts';
import { SendActions } from './SendActions.tsx';
import { useSend } from './useSend.ts';

/**
 * Send and Send later for a saved draft the reader shows, until the composer opens drafts. A draft
 * on its way can't be sent again until its send is undone.
 */
export function SendDraft({ draft, isCompact }: { draft: MessageRef; isCompact?: boolean }) {
  const send = useSend();
  const outbox = useQuery(outboxQuery).data ?? [];
  const onSend = (at?: string) => void send(draft, { at });
  return (
    <SendActions
      commands={sendCommands({ onSend, isEnabled: !isOnItsWay(outbox, draft) })}
      onPick={onSend}
      isCompact={isCompact}
    />
  );
}
