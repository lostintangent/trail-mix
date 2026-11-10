import { lazy } from 'react';
import { preloadable } from '../../../shared/preloadable.ts';

/**
 * What changes folders loads apart from the first screen: the menus, the name field when one is
 * named, and the question before a delete.
 */
export const FolderMenu = lazy(async () => ({
  default: (await import('./FolderMenu.tsx')).FolderMenu,
}));

export const { Component: ActionsMenu, preload: preloadActionsMenu } = preloadable(
  async () => (await import('./ActionsMenu.tsx')).ActionsMenu,
);

export const NameField = lazy(async () => ({
  default: (await import('./NameField.tsx')).NameField,
}));

export const DeleteQuestion = lazy(async () => ({
  default: (await import('./DeleteQuestion.tsx')).DeleteQuestion,
}));
