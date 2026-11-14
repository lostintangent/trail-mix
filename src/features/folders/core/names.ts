import type { Folder, FolderRef } from '../../mail/core/index.ts';

/**
 * How a folder nests in its account's tree. Paths are the server's: the parent's path, its
 * delimiter, then the name, or the name alone at the top.
 */

/** Whether two refs name the same folder. */
export const isAt = (ref: FolderRef, folder: FolderRef) =>
  ref.account === folder.account && ref.path === folder.path;

/** The folder a ref names, while the server lists it. */
export const folderAt = (folders: readonly Folder[], ref: FolderRef) =>
  folders.find((folder) => isAt(ref, folder));

/** Whether a ref names `folder` or a folder inside it, however deep. */
export const isWithin = (ref: FolderRef, folder: Folder) =>
  ref.account === folder.account &&
  (ref.path === folder.path ||
    (folder.delimiter !== undefined && ref.path.startsWith(`${folder.path}${folder.delimiter}`)));

/** Where a folder nests: the folder it's inside, if any, and its own name. */
export type Nesting = { parent?: Folder; name: string };

/**
 * Where a folder at `path` nests among its account's `folders`: inside the deepest of them whose
 * path and delimiter begin it, or at the top.
 */
export function nestingOf(path: string, folders: readonly Folder[]): Nesting {
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

/** What a folder's path holds before its name: its parent's path and delimiter, or nothing. */
export const prefixOf = (folder: Folder) =>
  folder.parent !== undefined && folder.delimiter ? `${folder.parent}${folder.delimiter}` : '';

/** The path a folder takes when it's renamed to `name`, in the same parent. */
export const renamedPath = (folder: Folder, name: string) => `${prefixOf(folder)}${name}`;

/** The folders inside a folder, however deep. */
export const inside = (folder: Folder, folders: readonly Folder[]) =>
  folders.filter((each) => each.path !== folder.path && isWithin(each, folder));

/**
 * Whether a folder is the member's own, to rename or delete: neither it nor any folder inside it
 * has a role. Some servers know a role only by a folder's name, so renaming Archive, or a folder
 * that holds one, would quietly stop archiving there.
 */
export const isOwn = (folder: Folder, folders: readonly Folder[]) =>
  [folder, ...inside(folder, folders)].every(
    ({ role, path }) => role === undefined && path.toUpperCase() !== 'INBOX',
  );
