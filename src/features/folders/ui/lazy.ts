import { lazy } from 'react';

/** The folder dialog loads when a folder is first created, renamed or deleted. */
export const FolderDialog = lazy(async () => ({
  default: (await import('./FolderDialog.tsx')).FolderDialog,
}));
