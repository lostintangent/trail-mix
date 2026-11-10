import { lazy } from 'react';

/**
 * The account screens load apart from the first screen, which has mail to show: the first-run
 * screen when there's none, an account's page, and the question before a removal.
 */
export const FirstRun = lazy(async () => ({
  default: (await import('./FirstRun.tsx')).FirstRun,
}));

export const AccountPage = lazy(async () => ({
  default: (await import('./AccountPage.tsx')).AccountPage,
}));

export const RemoveQuestion = lazy(async () => ({
  default: (await import('./RemoveQuestion.tsx')).RemoveQuestion,
}));
