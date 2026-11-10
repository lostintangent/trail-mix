import { preloadable } from '../../../shared/preloadable.ts';

/**
 * The composer, with its editor, loads apart from the first screen. It loads ahead while a
 * conversation is open, ready for a reply.
 */
export const { Component: Composer, preload: preloadComposer } = preloadable(
  async () => (await import('./Composer.tsx')).Composer,
);
