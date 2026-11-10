import { lazy } from 'react';
import { preloadable } from '../../../shared/preloadable.ts';

/**
 * The account screens load apart from the first screen, which has mail to show: the first-run
 * screen when there's none, an account's page, and the question before a removal. The first-run
 * screen shows once it has loaded, so it never waits behind an empty Suspense.
 */
export const { Component: FirstRun, preload: preloadFirstRun } = preloadable(
  async () => (await import('./FirstRun.tsx')).FirstRun,
);

export const AccountPage = lazy(async () => ({
  default: (await import('./AccountPage.tsx')).AccountPage,
}));

export const RemoveQuestion = lazy(async () => ({
  default: (await import('./RemoveQuestion.tsx')).RemoveQuestion,
}));
