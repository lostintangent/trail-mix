import { lazy } from 'react';
import { preloadable } from '../../../shared/preloadable.ts';
import { preloadSendCommands } from './useSendCommands.ts';

/**
 * The Outbox's views load apart from the first screen, which never needs them: the list when the
 * Outbox opens, and Send when a composer does.
 */
export const OutboxList = lazy(async () => ({
  default: (await import('./OutboxList.tsx')).OutboxList,
}));

/**
 * Send's buttons, and the commands they draw, load ahead with the composer. Until both are in, Send
 * suspends the composer it lies in, so its buttons are there the frame the composer is.
 */
export const { Component: SendActions, preload: preloadSendActions } = preloadable(async () => {
  const [{ SendActions }] = await Promise.all([import('./SendActions.tsx'), preloadSendCommands()]);
  return SendActions;
});
