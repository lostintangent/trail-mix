import { preloadable } from '../../../shared/preloadable.ts';

/** Members, in Settings, loads apart from the first screen, and only for the operator. */
export const { Component: MembersSettings, preload: preloadMembers } = preloadable(
  async () => (await import('./MembersSettings.tsx')).MembersSettings,
);
