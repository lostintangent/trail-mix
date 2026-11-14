import type { Folder } from '../../mail/core/index.ts';

/**
 * A folder's place in its account's tree. Paths are the server's: the parent's path, its delimiter,
 * then the name, or the name alone at the top.
 */

/** Where a folder sits: the folder it's inside, if any, and its own name. */
export type Place = { parent?: Folder; name: string };

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
