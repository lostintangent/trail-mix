import type { Folder } from '../../mail/core/index.ts';
import { inside, isOwn, placeOf } from './names.ts';

/**
 * Why a folder change can't be made, as a sentence the member reads. The browser checks a name
 * before it asks, and the Mailroom checks each change again, so both go by these rules.
 */

/** A name as a server that folds case would compare it. */
const comparable = (name: string) => name.normalize('NFC').toLowerCase();

/** The account's delimiter, which a name at the top of the account may not hold either. */
const delimiterOf = (folders: readonly Folder[]) =>
  folders.find((each) => each.delimiter)?.delimiter;

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
