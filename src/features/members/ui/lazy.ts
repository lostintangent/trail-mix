import { lazy } from 'react';

/** The Members page loads apart from the first screen, and only for the operator. */
export const MembersPage = lazy(async () => ({
  default: (await import('./MembersPage.tsx')).MembersPage,
}));
