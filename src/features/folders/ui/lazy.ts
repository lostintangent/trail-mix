import { lazy } from 'react';

/**
 * What changes folders loads apart from the first screen: the menu when a folder of the member's is
 * in view, the name field when one is named, and the question before a delete.
 */
export const FolderMenu = lazy(async () => ({
  default: (await import('./FolderMenu.tsx')).FolderMenu,
}));

export const NameField = lazy(async () => ({
  default: (await import('./NameField.tsx')).NameField,
}));

export const DeleteQuestion = lazy(async () => ({
  default: (await import('./DeleteQuestion.tsx')).DeleteQuestion,
}));
