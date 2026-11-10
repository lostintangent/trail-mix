import { lazy } from 'react';
import { preloadable } from '../../../shared/preloadable.ts';

/**
 * The Outbox's views load apart from the first screen, which never needs them: the list when the
 * Outbox opens, and Send when a composer does.
 */
export const OutboxList = lazy(async () => ({
  default: (await import('./OutboxList.tsx')).OutboxList,
}));

/** Send loads ahead with the composer, so its buttons are there the frame the composer is. */
export const { Component: SendActions, preload: preloadSendActions } = preloadable(
  async () => (await import('./SendActions.tsx')).SendActions,
);
