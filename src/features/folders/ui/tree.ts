import type { Folder, FolderRole } from '../../mail/core/index.ts';
import { folderName } from './name.ts';

/** A folder in an account's tree, with the folders inside it. */
export type FolderNode = { folder: Folder; children: FolderNode[] };

/** The roles a person visits most, then their own folders, then the bins. */
const ROLE_ORDER: Record<FolderRole, number> = {
  inbox: 0,
  archive: 1,
  sent: 2,
  drafts: 3,
  junk: 5,
  trash: 6,
};
const OWN = 4;

/**
 * One account's folders as the sidebar shows them. A folder with a role sits at the top wherever
 * the server keeps it, since folders are recognized by role. So does a folder whose parent isn't
 * listed, so that no folder goes missing. Every other folder sits inside its parent, by name.
 */
export function folderTree(folders: readonly Folder[]): FolderNode[] {
  const paths = new Set(folders.map(({ path }) => path));
  const isTop = ({ role, parent }: Folder) =>
    role !== undefined || parent === undefined || !paths.has(parent);
  const inside = Map.groupBy(
    folders.filter((folder) => !isTop(folder)),
    ({ parent }) => parent,
  );
  const node = (folder: Folder): FolderNode => ({
    folder,
    children: (inside.get(folder.path) ?? []).toSorted(byName).map(node),
  });
  return folders
    .filter(isTop)
    .toSorted((a, b) => rank(a) - rank(b) || byName(a, b))
    .map(node);
}

const rank = ({ role }: Folder) => (role ? ROLE_ORDER[role] : OWN);
const byName = (a: Folder, b: Folder) => folderName(a).localeCompare(folderName(b));
