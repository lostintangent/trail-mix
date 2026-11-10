import { Clock, Send } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import {
  sameRef,
  type Folder,
  type Message,
  type MessageRef,
  type Outgoing,
} from '../../mail/core/index.ts';
import { laterTimes, type Later } from '../core/later.ts';

export const SEND = 'outbox.send';
/** The prefix of the Send later commands, one for each time ahead that Send later offers. */
export const SEND_LATER = 'outbox.later:';

export const GROUP = 'Send';

/**
 * Send, and Send later at each time it offers now, as commands for whatever holds a draft: the
 * composer, which gives Send its key, or the reader beside a saved draft. `SendActions` draws them.
 */
export function sendCommands({
  onSend,
  isEnabled = true,
  shortcut,
}: {
  onSend: (at?: string) => void;
  isEnabled?: boolean;
  shortcut?: string;
}): Command[] {
  // A time is worked out as it's chosen, so a menu left open doesn't send an hour early.
  const at = (label: Later['label'], offered: Date) =>
    (laterTimes(new Date()).find((each) => each.label === label)?.at ?? offered).toISOString();
  return [
    { id: SEND, title: 'Send', group: GROUP, icon: Send, shortcut, isEnabled, run: () => onSend() },
    ...laterTimes(new Date()).map(({ label, at: offered }) => ({
      id: `${SEND_LATER}${label}`,
      title: `Send ${label.toLowerCase()}`,
      group: GROUP,
      icon: Clock,
      isEnabled,
      run: () => onSend(at(label, offered)),
    })),
  ];
}

/** The draft in a conversation that Send sends: its newest message in a Drafts folder. */
export function draftIn(
  conversation: readonly Message[],
  folders: readonly Folder[],
): MessageRef | undefined {
  const draft = conversation.findLast((message) =>
    folders.some(
      ({ account, path, role }) =>
        role === 'drafts' && account === message.account && path === message.path,
    ),
  );
  return (
    draft && {
      account: draft.account,
      path: draft.path,
      uidValidity: draft.uidValidity,
      uid: draft.uid,
    }
  );
}

/** Whether a draft is on its way, so it can't be sent again until its send is undone. */
export const isOnItsWay = (outbox: readonly Outgoing[], draft: MessageRef) =>
  outbox.some((outgoing) => sameRef(outgoing.draft, draft) && outgoing.state !== 'failed');
