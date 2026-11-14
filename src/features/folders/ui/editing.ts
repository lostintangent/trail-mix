import { useCallback, useMemo, useState } from 'react';
import { useLatest } from '../../../shared/useLatest.ts';
import { folderAt, type Account, type Folder, type View } from '../../mail/core/index.ts';
import { followed, type FolderChange } from '../core/changes.ts';
import { childPath, renamedPath } from '../core/names.ts';
import { useFolderChange } from './changes.ts';
import { createCommands, folderActions, type FolderEdit } from './commands.ts';

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Making, renaming and deleting folders from the workbench: the folder being named in place, the
 * one whose delete is being asked about, and the commands that start each. A change shows at once,
 * and the view follows a folder it's in, and comes back if the server refuses.
 */
export function useFolderEditing({
  accounts,
  folders,
  view,
  open,
  reveal,
}: {
  accounts: readonly Account[];
  folders: readonly Folder[];
  view: View;
  /** Shows another view, as following a renamed or deleted folder does. */
  open: (view: View) => void;
  /** Brings the sidebar, where folders are named, into view. */
  reveal: () => void;
}) {
  const [editing, setEditing] = useState<FolderEdit>();
  const [deleting, setDeleting] = useState<Folder>();
  const change = useFolderChange();
  // What the handlers read as they run, so the ones the sidebar holds stay the same as the folders'
  // counts change, and a count redraws only the lines that show it.
  const latest = useLatest({ folders, view, editing, reveal });

  const make = useCallback(
    async (made: FolderChange) => {
      const before = latest.current.view;
      const after = followed(before, made);
      if (after !== before) open(after);
      const isAccepted = await change(made);
      // A refused change brings the view back to where it was, if the member hasn't moved on.
      if (!isAccepted && after !== before && sameView(latest.current.view, after)) open(before);
    },
    [change, open, latest],
  );

  const edit = useCallback(
    (next: FolderEdit) => {
      setEditing(next);
      latest.current.reveal();
    },
    [latest],
  );

  const onEdited = useCallback(
    (name: string | undefined) => {
      const { editing, folders } = latest.current;
      setEditing(undefined);
      if (!editing || name === undefined) return;
      if (editing.do === 'rename') {
        void make({ do: 'rename', folder: editing.folder, to: renamedPath(editing.folder, name) });
        return;
      }
      const { account, parent } = editing;
      const delimiter =
        parent?.delimiter ??
        folders.find((folder) => folder.account === account && folder.delimiter)?.delimiter;
      void make({
        do: 'create',
        folder: {
          account,
          path: childPath(parent, name),
          name,
          ...(parent ? { parent: parent.path } : {}),
          ...(delimiter ? { delimiter } : {}),
          unread: 0,
          total: 0,
        },
      });
    },
    [make, latest],
  );

  // The folder in view's, in the registry and the menu at the head of its list.
  const inView = useMemo(
    () =>
      folderActions({
        folder: view.in === 'folder' ? folderAt(folders, view.folder) : undefined,
        folders,
        edit,
        remove: setDeleting,
      }),
    [folders, view, edit],
  );
  const commands = useMemo(
    () => [...createCommands(accounts, edit), ...inView],
    [accounts, edit, inView],
  );
  // Each folder's own, for the menu on its row, asked as the menu opens.
  const actionsFor = useCallback(
    (folder: Folder) =>
      folderActions({ folder, folders: latest.current.folders, edit, remove: setDeleting }),
    [edit, latest],
  );

  return {
    editing,
    onEdited,
    deleting,
    closeDelete: useCallback(() => setDeleting(undefined), []),
    confirmDelete: useCallback(
      () => deleting && void make({ do: 'delete', folder: deleting }),
      [deleting, make],
    ),
    commands,
    inView,
    actionsFor,
  };
}
