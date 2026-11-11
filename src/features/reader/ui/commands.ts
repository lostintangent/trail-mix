import type { Command } from '../../commands/index.ts';

/**
 * Viewing a message's raw source and headers. Each message's own menu holds one for that message,
 * and the registry's opens the newest message of the conversation open, or can't run while none is.
 */
export function sourceCommand(view: (() => void) | undefined): Command {
  return {
    id: 'message.source',
    title: 'View source',
    group: 'Message',
    menuIcon: 'code',
    isEnabled: view !== undefined,
    run: () => view?.(),
  };
}
