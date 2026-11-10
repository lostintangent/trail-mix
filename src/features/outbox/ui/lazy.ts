import { lazy } from 'react';

/**
 * The Outbox's views load apart from the first screen, which never needs them: the list when the
 * Outbox opens, and Send when a composer does.
 */
export const OutboxList = lazy(async () => ({
  default: (await import('./OutboxList.tsx')).OutboxList,
}));

export const SendActions = lazy(async () => ({
  default: (await import('./SendActions.tsx')).SendActions,
}));
