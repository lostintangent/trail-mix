import type { Folder, View } from '../../mail/core/index.ts';
import { inside } from './names.ts';

/**
 * A change to an account's folders on its way to the server, which the browser shows at once by
 * laying it over the Mailroom's snapshot until a snapshot shows it, or lifts if the server refuses.
 */
export type FolderChange =
  /** The new folder, as the server will list it. */
  | { do: 'create'; folder: Folder }
  | { do: 'rename'; folder: Folder; to: string }
  | { do: 'delete'; folder: Folder };

const at = (folders: readonly Folder[], { account, path }: Pick<Folder, 'account' | 'path'>) =>
  folders.some((held) => held.account === account && held.path === path);

/** An account's folders with a change made: a rename carries the folders inside along. */
export function changed(folders: readonly Folder[], change: FolderChange): Folder[] {
  const { folder } = change;
  const mine = folders.filter(({ account }) => account === folder.account);
  switch (change.do) {
    case 'create':
      return at(folders, folder) ? [...folders] : [...folders, folder];
    case 'delete': {
      const goes = new Set([folder.path, ...inside(folder, mine).map(({ path }) => path)]);
      return folders.filter(({ account, path }) => account !== folder.account || !goes.has(path));
    }
    case 'rename': {
      const moves = new Set([folder.path, ...inside(folder, mine).map(({ path }) => path)]);
      const moved = (path: string) => `${change.to}${path.slice(folder.path.length)}`;
      const name =
        folder.parent !== undefined && folder.delimiter
          ? change.to.slice(folder.parent.length + folder.delimiter.length)
          : change.to;
      return folders.map((held) =>
        held.account !== folder.account || !moves.has(held.path)
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
  const { folder } = change;
  switch (change.do) {
    case 'create':
      return at(folders, folder);
    case 'delete':
      return !at(folders, folder);
    case 'rename':
      return !at(folders, folder) && at(folders, { account: folder.account, path: change.to });
  }
}

/**
 * Where a view goes when a change is made: from a renamed folder, or one inside it, to its new path,
 * and from a deleted one to the Inbox. Any other view stays.
 */
export function followed(view: View, change: FolderChange): View {
  if (view.in !== 'folder' || change.do === 'create') return view;
  const { folder } = change;
  const { account, path } = view.folder;
  const isWithin =
    account === folder.account &&
    (path === folder.path ||
      (folder.delimiter !== undefined && path.startsWith(`${folder.path}${folder.delimiter}`)));
  if (!isWithin) return view;
  if (change.do === 'delete') return { in: 'inbox' };
  return {
    in: 'folder',
    folder: { account, path: `${change.to}${path.slice(folder.path.length)}` },
  };
}
