import type { Account, Folder, FolderRef, FolderRole, View } from '../../mail/core/index.ts';
import type { FolderEdit } from './commands.ts';
import { foldKey } from './folds.ts';
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

/**
 * What every line of the tree shows from: the view, what this device keeps folded, and the folder
 * being named in place, if any.
 */
export type TreeState = {
  view: View;
  folds: ReadonlySet<string>;
  editing: FolderEdit | undefined;
};

/**
 * How an account's line shows. It's open unless folded, and while a folder in it is named. Folded,
 * it counts the unread mail inside, in the accent when some is in its Inbox, and lifts when it holds
 * the view. Until its folders are first listed, lines in their shape stand in for them.
 */
export function accountLine(
  account: Account,
  nodes: readonly FolderNode[],
  { view, folds, editing }: TreeState,
) {
  const isNamedIn =
    editing?.do === 'create'
      ? editing.account.id === account.id
      : editing?.folder.account === account.id;
  const isOpen = !folds.has(foldKey({ account: account.id })) || isNamedIn;
  return {
    isOpen,
    isHolding: !isOpen && view.in === 'folder' && view.folder.account === account.id,
    unread: isOpen ? 0 : unreadInAccount(nodes),
    isUnreadInInbox:
      !isOpen && nodes.some(({ folder }) => folder.role === 'inbox' && folder.unread > 0),
    // Every mailbox has an Inbox, so an account with no folders has yet to be listed, unless it
    // can't be reached, which its own status says.
    isListing: nodes.length === 0 && (account.status === 'ready' || account.status === 'syncing'),
  };
}

/**
 * How a folder's line shows. It's open unless folded, and while a folder inside it is named, and
 * shows its name in a field while it's renamed. Folded, it counts the unread mail inside it too,
 * and lifts when it holds the view. A folder a new one is named in opens to show the new one's
 * field, though nothing is inside it yet.
 */
export function folderLine(node: FolderNode, { view, folds, editing }: TreeState) {
  const { folder, children } = node;
  const isRenaming = editing?.do === 'rename' && isAt(editing.folder, folder);
  const namedAt = editing?.do === 'create' ? editing.parent : editing?.folder;
  const isNamingInside =
    namedAt !== undefined &&
    namedAt.account === folder.account &&
    holds(node, namedAt.path) &&
    !isRenaming;
  const isOpen = !folds.has(foldKey(folder)) || isNamingInside;
  return {
    isRenaming,
    isSelected: view.in === 'folder' && isAt(view.folder, folder),
    isOpen,
    isHolding:
      !isOpen &&
      view.in === 'folder' &&
      view.folder.account === folder.account &&
      holds(node, view.folder.path),
    count: isOpen ? folder.unread : unreadWithin(node),
    canFold: children.length > 0,
    holdsNewFolder:
      editing?.do === 'create' && editing.parent !== undefined && isAt(editing.parent, folder),
  };
}

/**
 * Where a new folder's field goes among `nodes`, the folders at the top of `account` or inside
 * `parent`, or nothing when the new folder isn't named there. It's named where the member's own
 * folders sit: first inside a folder, and at the top of an account before Junk and Trash.
 */
export function newFolderAt(
  nodes: readonly FolderNode[],
  editing: FolderEdit | undefined,
  account: string,
  parent?: Folder,
): number | undefined {
  if (editing?.do !== 'create' || editing.account.id !== account) return undefined;
  if (editing.parent?.path !== parent?.path) return undefined;
  if (parent) return 0;
  const bins = nodes.findIndex(({ folder }) => folder.role === 'junk' || folder.role === 'trash');
  return bins < 0 ? nodes.length : bins;
}

/** The unread mail in a folder and every folder inside it, which it shows while folded. */
const unreadWithin = ({ folder, children }: FolderNode): number =>
  children.reduce((sum, child) => sum + unreadWithin(child), folder.unread);

/**
 * The unread mail in an account's tree, which it shows while folded. Junk and Trash stay out of
 * it, since nothing in them waits to be read.
 */
const unreadInAccount = (nodes: readonly FolderNode[]): number =>
  nodes
    .filter(({ folder }) => folder.role !== 'junk' && folder.role !== 'trash')
    .reduce((sum, node) => sum + unreadWithin(node), 0);

/** Whether a folder in an account's tree is this node or sits inside it. */
const holds = ({ folder, children }: FolderNode, path: string): boolean =>
  folder.path === path || children.some((child) => holds(child, path));

const isAt = (ref: FolderRef, folder: Folder) =>
  ref.account === folder.account && ref.path === folder.path;
