import { Forward, Reply, ReplyAll, SquarePen } from 'lucide-react';
import type { Command } from '../../commands/index.ts';

/**
 * Writing's commands: a new message, a reply to the open conversation, to its sender or to
 * everyone on it, and a forward of it. One with nothing to answer or forward can't run.
 */
export function composerCommands({
  write,
  reply,
  forward,
}: {
  /** Starts a new message, or nothing while there's no account to send it from. */
  write: (() => void) | undefined;
  /** Replies to the open conversation, or nothing while none is open. */
  reply: ((all: boolean) => void) | undefined;
  /** Forwards the open conversation's newest message, or nothing while none is open. */
  forward: (() => void) | undefined;
}): Command[] {
  return [
    {
      id: 'message.new',
      title: 'New message',
      group: 'Message',
      shortcut: 'C',
      icon: SquarePen,
      isEnabled: write !== undefined,
      run: () => write?.(),
    },
    {
      id: 'message.reply',
      title: 'Reply',
      group: 'Message',
      shortcut: 'R',
      icon: Reply,
      isEnabled: reply !== undefined,
      run: () => reply?.(false),
    },
    {
      id: 'message.replyAll',
      title: 'Reply all',
      group: 'Message',
      shortcut: 'A',
      icon: ReplyAll,
      isEnabled: reply !== undefined,
      run: () => reply?.(true),
    },
    {
      id: 'message.forward',
      title: 'Forward',
      group: 'Message',
      shortcut: 'F',
      icon: Forward,
      isEnabled: forward !== undefined,
      run: () => forward?.(),
    },
  ];
}
