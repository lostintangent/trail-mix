import { preloadable } from '../../../shared/preloadable.ts';

/**
 * The reader, with its sanitizer, loads apart from the first rows, which don't need it. It loads
 * ahead while the browser is idle, ready for the first conversation opened.
 */
export const { Component: Reader, preload: preloadReader } = preloadable(
  async () => (await import('./Reader.tsx')).Reader,
);

/** A message's source and headers, which load when they are asked for. */
export const { Component: SourceDialog } = preloadable(
  async () => (await import('./SourceDialog.tsx')).SourceDialog,
);

/** A bundle's threads, which load with the first bundle opened. */
export const { Component: BundleReader, preload: preloadBundleReader } = preloadable(
  async () => (await import('./BundleReader.tsx')).BundleReader,
);
