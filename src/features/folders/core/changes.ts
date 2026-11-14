import { folderAt, type Folder, type View } from '../../mail/core/index.ts';
import { isWithin, prefixOf } from './names.ts';

/**
 * A change to an account's folders on its way to the server, which the browser shows at once by
 * laying it over the Mailroom's snapshot until a snapshot shows it, or lifts if the server refuses.
 */
export type FolderChange =
  /** The new folder, as the server will list it. */
  | { do: 'create'; folder: Folder }
  | { do: 'rename'; folder: Folder; to: string }
  | { do: 'delete'; folder: Folder };

/** An account's folders with a change made: a rename carries the folders inside along. */
export function changed(folders: readonly Folder[], change: FolderChange): Folder[] {
  const { folder } = change;
  switch (change.do) {
    case 'create':
      return folderAt(folders, folder) ? [...folders] : [...folders, folder];
    case 'delete':
      return folders.filter((held) => !isWithin(held, folder));
    case 'rename': {
      const moved = (path: string) => `${change.to}${path.slice(folder.path.length)}`;
      const name = change.to.slice(prefixOf(folder).length);
      return folders.map((held) =>
        !isWithin(held, folder)
          ? held
          : held.path === folder.path
            ? { ...held, path: change.to, name }
            : { ...held, path: moved(held.path), parent: moved(held.parent!) },
      );
    }
  }
}

/** Whether a snapshot of the folders already shows a change, so laying it over is done. */
export function isShown(folders: readonly Folder[], change: FolderChange): boolean {
  const { account, path } = change.folder;
  const isListed = (at: string) => folderAt(folders, { account, path: at }) !== undefined;
  switch (change.do) {
    case 'create':
      return isListed(path);
    case 'delete':
      return !isListed(path);
    case 'rename':
      return !isListed(path) && isListed(change.to);
  }
}

/**
 * Where a view goes when a change is made: from a renamed folder, or one inside it, to its new path,
 * still listing only its unread mail if it did, and from a deleted one to the Inbox. Any other view
 * stays.
 */
export function followed(view: View, change: FolderChange): View {
  if (view.in !== 'folder' || change.do === 'create' || !isWithin(view.folder, change.folder))
    return view;
  if (change.do === 'delete') return { in: 'inbox' };
  const { account, path } = view.folder;
  return {
    ...view,
    folder: { account, path: `${change.to}${path.slice(change.folder.path.length)}` },
  };
}

/**
 * A view as the account's folders stand: a folder that's no longer there, or whose account has
 * gone, gives way to the Inbox, as an address saved before it went does. Any other view stays.
 */
export function standing(view: View, folders: readonly Folder[]): View {
  return view.in === 'folder' && !folderAt(folders, view.folder) ? { in: 'inbox' } : view;
}
