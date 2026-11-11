import { Clock, Send } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import { laterTimes, type Later } from '../core/later.ts';
import { GROUP } from './commands.ts';

export const SEND = 'outbox.send';
/** The prefix of the Send later commands, one for each time ahead that Send later offers. */
export const SEND_LATER = 'outbox.later:';

/**
 * Send, and Send later at each time it offers now, as commands for whatever holds a draft: the
 * composer, which gives Send its key. `SendActions` draws them.
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
