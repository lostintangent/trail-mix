import type { Folder } from '../../mail/core/index.ts';

/**
 * A folder's place in its account's tree, and the names a folder may take there. The browser checks
 * a change before it asks, and the Mailroom checks it again, so both go by these rules. Paths are the
 * server's: the parent's path, its delimiter, then the name, or the name alone at the top.
 */

/** Where a folder sits: the folder it's inside, if any, and its own name. */
export type Place = { parent?: Folder; name: string };

/** A name as a server that folds case would compare it. */
const comparable = (name: string) => name.normalize('NFC').toLowerCase();

/** The account's delimiter, which a name at the top of the account may not hold either. */
const delimiterOf = (folders: readonly Folder[]) =>
  folders.find((each) => each.delimiter)?.delimiter;

/**
 * Where a folder at `path` sits among its account's `folders`: inside the deepest of them whose path
 * and delimiter begin it, or at the top.
 */
export function placeOf(path: string, folders: readonly Folder[]): Place {
  let parent: Folder | undefined;
  for (const folder of folders) {
    const isAbove = folder.delimiter && path.startsWith(`${folder.path}${folder.delimiter}`);
    if (isAbove && folder.path.length > (parent?.path.length ?? -1)) parent = folder;
  }
  return parent
    ? { parent, name: path.slice(parent.path.length + parent.delimiter!.length) }
    : { name: path };
}

/**
 * Why `name` can't name a folder in the folder at `parent`, or at the top of the account, as a
 * sentence, or nothing if it can. `delimiter` is the server's there, the account's at the top unless
 * given. A folder being renamed isn't its own sibling, so it may change only its name's case.
 */
export function nameProblem(
  name: string,
  {
    folders,
    parent,
    delimiter = delimiterOf(folders),
    renaming,
  }: { folders: readonly Folder[]; parent?: string; delimiter?: string; renaming?: Folder },
): string | undefined {
  if (name.trim() === '') return 'A folder needs a name.';
  if (name !== name.trim()) return 'A folder’s name can’t start or end with a space.';
  if (delimiter && name.includes(delimiter)) return `A folder’s name can’t hold “${delimiter}”.`;
  if (parent === undefined && comparable(name) === 'inbox')
    return '“Inbox” is the Inbox’s own name.';
  const isTaken = folders.some(
    (folder) =>
      folder.path !== renaming?.path &&
      folder.parent === parent &&
      comparable(folder.name) === comparable(name),
  );
  return isTaken ? `There’s already a folder called “${name}” here.` : undefined;
}

/** Why a new folder can't be at `path`, or nothing if it can: its parent is held, and its name fits. */
export function createProblem(path: string, folders: readonly Folder[]): string | undefined {
  const { parent, name } = placeOf(path, folders);
  return nameProblem(name, { folders, parent: parent?.path, delimiter: parent?.delimiter });
}

/**
 * Why `folder` can't be renamed to the path `to`, or nothing if it can: it's the member's own, and
 * `to` keeps it in its parent under a name that fits.
 */
export function renameProblem(
  folder: Folder,
  to: string,
  folders: readonly Folder[],
): string | undefined {
  if (!isOwn(folder, folders)) return ownProblem(folder, folders);
  const within =
    folder.parent !== undefined && folder.delimiter ? `${folder.parent}${folder.delimiter}` : '';
  if (!to.startsWith(within)) return 'A rename keeps a folder where it is.';
  return nameProblem(to.slice(within.length), {
    folders,
    parent: folder.parent,
    delimiter: folder.delimiter,
    renaming: folder,
  });
}

/** Why `folder` can't be deleted, or nothing if it can: it's the member's own. */
export const deleteProblem = (folder: Folder, folders: readonly Folder[]) =>
  isOwn(folder, folders) ? undefined : ownProblem(folder, folders);

const ownProblem = (folder: Folder, folders: readonly Folder[]) =>
  inside(folder, folders).some(({ role }) => role !== undefined)
    ? 'A folder that holds one of the account’s own folders, such as Archive, stays as it is.'
    : 'The account’s own folders, such as Inbox and Archive, stay as they are.';

/** Whether a folder can hold folders: its server's folders nest. */
export const canHoldFolders = (folder: Folder) => folder.delimiter !== undefined;

/** The path of a folder named `name` inside `parent`, or at the top of its account. */
export function childPath(parent: Folder | undefined, name: string): string {
  if (!parent) return name;
  if (!parent.delimiter) throw new Error('That folder can’t hold folders.');
  return `${parent.path}${parent.delimiter}${name}`;
}

/** The path a folder takes when it's renamed to `name`, in the same parent. */
export function renamedPath(folder: Folder, name: string): string {
  return folder.parent !== undefined && folder.delimiter
    ? `${folder.parent}${folder.delimiter}${name}`
    : name;
}

/** The folders inside a folder, however deep. */
export function inside(folder: Folder, folders: readonly Folder[]): Folder[] {
  if (!folder.delimiter) return [];
  const above = `${folder.path}${folder.delimiter}`;
  return folders.filter(({ path }) => path.startsWith(above));
}

/**
 * Whether a folder is the member's own, to rename or delete: neither it nor any folder inside it
 * has a role. Some servers know a role only by a folder's name, so renaming Archive, or a folder
 * that holds one, would quietly stop archiving there.
 */
export const isOwn = (folder: Folder, folders: readonly Folder[]) =>
  [folder, ...inside(folder, folders)].every(
    ({ role, path }) => role === undefined && path.toUpperCase() !== 'INBOX',
  );

/** What deleting a folder takes with it: the folders inside it, and the messages in them all. */
export function whatGoes(folder: Folder, folders: readonly Folder[]) {
  const within = inside(folder, folders);
  return {
    folders: within.length,
    messages: [folder, ...within].reduce((sum, { total }) => sum + total, 0),
  };
}
