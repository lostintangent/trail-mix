import { expect, test } from 'bun:test';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import type { FolderEdit } from './commands.ts';
import { foldKey, type Foldable } from './folds.ts';
import {
  accountLine,
  folderLine,
  folderTree,
  newFolderAt,
  type FolderNode,
  type TreeState,
} from './tree.ts';

const folder = (path: string, extra: Partial<Folder> = {}): Folder => {
  const slash = path.lastIndexOf('/');
  return {
    account: 'personal',
    path,
    name: path.slice(slash + 1),
    ...(slash > 0 && { parent: path.slice(0, slash) }),
    unread: 0,
    total: 0,
    ...extra,
  };
};

/** The tree as the sidebar reads it, one line per folder, indented by depth. */
const outline = (nodes: FolderNode[], depth = 0): string[] =>
  nodes.flatMap(({ folder, children }) => [
    '  '.repeat(depth) + folder.name,
    ...outline(children, depth + 1),
  ]);

test('the roles come first, then the account’s own folders by name, then the bins', () => {
  const folders = [
    folder('Trash', { role: 'trash' }),
    folder('Receipts'),
    folder('Sent', { role: 'sent' }),
    folder('Junk', { role: 'junk' }),
    folder('Drafts', { role: 'drafts' }),
    folder('Archive', { role: 'archive' }),
    folder('Projects'),
    folder('INBOX', { name: 'Inbox', role: 'inbox' }),
  ];

  expect(outline(folderTree(folders))).toEqual([
    'Inbox',
    'Archive',
    'Sent',
    'Drafts',
    'Projects',
    'Receipts',
    'Junk',
    'Trash',
  ]);
});

test('a folder sits inside its parent, by name, however deep', () => {
  const folders = [
    folder('Projects/Trail Mix/Design'),
    folder('Receipts'),
    folder('Projects/Trail Mix'),
    folder('Projects'),
    folder('Projects/Toy Box'),
  ];

  expect(outline(folderTree(folders))).toEqual([
    'Projects',
    '  Toy Box',
    '  Trail Mix',
    '    Design',
    'Receipts',
  ]);
});

test('a folder whose parent isn’t listed still shows, at the top', () => {
  const folders = [folder('Lists/Bun'), folder('Lists/Cloudflare/Workers'), folder('Receipts')];

  expect(outline(folderTree(folders))).toEqual(['Bun', 'Receipts', 'Workers']);
});

test('a folder with a role sits at the top wherever the server keeps it', () => {
  const folders = [
    folder('[Gmail]'),
    folder('[Gmail]/Sent Mail', { role: 'sent' }),
    folder('[Gmail]/Starred'),
    folder('INBOX', { name: 'Inbox', role: 'inbox' }),
  ];

  expect(outline(folderTree(folders))).toEqual(['Inbox', 'Sent Mail', '[Gmail]', '  Starred']);
});

const account = (id: string, status: Account['status'] = 'ready'): Account => ({
  id,
  name: id,
  address: `${id}@trailmix.test`,
  provider: 'demo',
  stamp: 'teal',
  allowImagesFrom: [],
  lightPaperFrom: [],
  status,
});

/** The tree's state, with what's listed folded and nothing named unless said. */
const state = (folded: Foldable[], more: Partial<TreeState> = {}): TreeState => ({
  view: { in: 'inbox' },
  folds: new Set(folded.map(foldKey)),
  editing: undefined,
  ...more,
});

const inFolder = (path: string, id = 'personal'): View => ({
  in: 'folder',
  folder: { account: id, path },
});

/** The node at `path` in a tree, however deep. */
const nodeAt = (nodes: readonly FolderNode[], path: string): FolderNode =>
  nodes.find(({ folder }) => folder.path === path) ??
  nodeAt(
    nodes.flatMap(({ children }) => children),
    path,
  );

const projects = folderTree([
  folder('Projects', { unread: 1, delimiter: '/' }),
  folder('Projects/Trail Mix', { unread: 2, delimiter: '/' }),
  folder('Projects/Trail Mix/Design', { unread: 4, delimiter: '/' }),
  folder('Projects/Toy Box', { delimiter: '/' }),
]);
const line = (path: string, at: TreeState) => folderLine(nodeAt(projects, path), at);

test('a folded folder counts the unread mail in it and every folder inside it, however deep', () => {
  expect(line('Projects', state([])).count).toBe(1);
  expect(line('Projects', state([folder('Projects')])).count).toBe(7);
});

test('a folded account counts its unread mail outside Junk and Trash, in the accent for its Inbox', () => {
  const nodes = folderTree([
    folder('INBOX', { name: 'Inbox', role: 'inbox', unread: 3 }),
    folder('Projects', { unread: 1 }),
    folder('Projects/Toy Box', { unread: 2 }),
    folder('Junk', { role: 'junk', unread: 40 }),
    folder('Trash', { role: 'trash', unread: 457 }),
  ]);
  const personal = account('personal');

  expect(accountLine(personal, nodes, state([]))).toMatchObject({ unread: 0 });
  expect(accountLine(personal, nodes, state([{ account: 'personal' }]))).toMatchObject({
    unread: 6,
    isUnreadInInbox: true,
  });
});

test('a folded line lifts while it holds the view, which an open one leaves to the view’s own', () => {
  const design = state([], { view: inFolder('Projects/Trail Mix/Design') });
  expect(line('Projects', design)).toMatchObject({ isHolding: false, isSelected: false });
  expect(line('Projects/Trail Mix/Design', design)).toMatchObject({ isSelected: true });

  const folded = { ...design, folds: state([folder('Projects')]).folds };
  expect(line('Projects', folded)).toMatchObject({ isHolding: true, isSelected: false });
  expect(
    accountLine(account('personal'), projects, {
      ...folded,
      folds: state([{ account: 'personal' }]).folds,
    }),
  ).toMatchObject({ isHolding: true });
});

test('naming a folder unfolds every folder around it for as long as it’s named', () => {
  const folded = [{ account: 'personal' }, folder('Projects'), folder('Projects/Trail Mix')];
  const creating: FolderEdit = {
    do: 'create',
    account: account('personal'),
    parent: folder('Projects/Trail Mix', { delimiter: '/' }),
  };
  expect(
    accountLine(account('personal'), projects, state(folded, { editing: creating })).isOpen,
  ).toBe(true);
  expect(line('Projects', state(folded, { editing: creating })).isOpen).toBe(true);
  expect(line('Projects/Trail Mix', state(folded, { editing: creating })).isOpen).toBe(true);

  // Renamed, a folder shows its name in a field, and what's inside it stays as it was.
  const renaming: FolderEdit = { do: 'rename', folder: folder('Projects/Trail Mix') };
  expect(line('Projects', state(folded, { editing: renaming })).isOpen).toBe(true);
  expect(line('Projects/Trail Mix', state(folded, { editing: renaming }))).toMatchObject({
    isRenaming: true,
    isOpen: false,
  });
});

test('a folder a new one is named in opens to hold its field, though nothing is inside it yet', () => {
  const editing: FolderEdit = {
    do: 'create',
    account: account('personal'),
    parent: folder('Projects/Toy Box', { delimiter: '/' }),
  };
  expect(line('Projects/Toy Box', state([], { editing }))).toMatchObject({
    canFold: false,
    holdsNewFolder: true,
    isOpen: true,
  });
});

test('another account’s folder at the same path is not named, unfolded or lifted with it', () => {
  const folded = [{ account: 'personal' }, folder('Projects'), folder('Projects/Trail Mix')];
  const work = (path: string) => folder(path, { account: 'work', delimiter: '/' });
  const edits: FolderEdit[] = [
    { do: 'rename', folder: work('Projects/Trail Mix') },
    { do: 'create', account: account('work'), parent: work('Projects/Trail Mix') },
  ];
  for (const editing of edits) {
    const at = state(folded, { editing, view: inFolder('Projects/Trail Mix/Design', 'work') });
    expect(accountLine(account('personal'), projects, at)).toMatchObject({
      isOpen: false,
      isHolding: false,
    });
    expect(line('Projects', at)).toMatchObject({ isOpen: false, isHolding: false });
    expect(line('Projects/Trail Mix', at)).toMatchObject({
      isRenaming: false,
      isOpen: false,
      holdsNewFolder: false,
    });
  }
});

test('a new folder is named first inside a folder, and before Junk and Trash at the top', () => {
  const top = folderTree([
    folder('INBOX', { name: 'Inbox', role: 'inbox' }),
    folder('Receipts'),
    folder('Junk', { role: 'junk' }),
    folder('Trash', { role: 'trash' }),
  ]);
  const projectsFolder = folder('Projects', { delimiter: '/' });
  const at = (parent?: Folder): FolderEdit => ({
    do: 'create',
    account: account('personal'),
    parent,
  });

  expect(newFolderAt(top, at(), 'personal')).toBe(2);
  expect(newFolderAt(top.slice(0, 2), at(), 'personal')).toBe(2);
  expect(newFolderAt(projects[0]!.children, at(projectsFolder), 'personal', projectsFolder)).toBe(
    0,
  );
  // Nowhere else: not at the top while it's named in a folder, nor in another account.
  expect(newFolderAt(top, at(projectsFolder), 'personal')).toBeUndefined();
  expect(newFolderAt(top, at(), 'work')).toBeUndefined();
});

test('an account with no folders yet shows lines in their shape, unless it can’t be reached', () => {
  expect(accountLine(account('personal', 'syncing'), [], state([])).isListing).toBe(true);
  expect(accountLine(account('personal', 'error'), [], state([])).isListing).toBe(false);
  expect(accountLine(account('personal', 'needs-sign-in'), [], state([])).isListing).toBe(false);
  expect(accountLine(account('personal'), projects, state([])).isListing).toBe(false);
});
