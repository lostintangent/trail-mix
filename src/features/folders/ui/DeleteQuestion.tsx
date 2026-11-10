import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import type { Folder } from '../../mail/core/index.ts';
import { deleteSaid } from '../core/question.ts';

/**
 * The question before a folder is deleted, which can't be undone: what goes with it, the folders
 * inside it and all their messages, counted from what the browser holds.
 */
export function DeleteQuestion({
  folder,
  folders,
  onDelete,
  onClose,
}: {
  folder: Folder;
  folders: readonly Folder[];
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={`Delete ${folder.name}?`}
      description={deleteSaid(folder, folders)}
      actionLabel="Delete"
      actionVariant="destructive"
      onAction={() => {
        onClose();
        onDelete();
      }}
    />
  );
}
