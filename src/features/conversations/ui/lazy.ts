import { lazy } from 'react';

/**
 * The triage controls, with their menus, load apart from the first rows, which don't need them.
 * They show only beside an open conversation, so they load while the browser is idle, with the
 * reader.
 */
const load = () => import('./TriageActions.tsx');

export const TriageActions = lazy(async () => ({ default: (await load()).TriageActions }));

export function preloadTriageActions() {
  void load();
}
