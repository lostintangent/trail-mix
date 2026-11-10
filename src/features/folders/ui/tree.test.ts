import { expect, test } from 'bun:test';
import type { Folder } from '../../mail/core/index.ts';
import { folderTree, unreadInAccount, unreadWithin, type FolderNode } from './tree.ts';

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

test('a folded folder counts the unread mail in it and every folder inside it, however deep', () => {
  const [projects] = folderTree([
    folder('Projects', { unread: 1 }),
    folder('Projects/Trail Mix', { unread: 2 }),
    folder('Projects/Trail Mix/Design', { unread: 4 }),
    folder('Projects/Toy Box'),
  ]);

  expect(unreadWithin(projects!)).toBe(7);
});

test('a folded account counts its unread mail outside Junk and Trash', () => {
  const nodes = folderTree([
    folder('INBOX', { name: 'Inbox', role: 'inbox', unread: 3 }),
    folder('Projects', { unread: 1 }),
    folder('Projects/Toy Box', { unread: 2 }),
    folder('Junk', { role: 'junk', unread: 40 }),
    folder('Trash', { role: 'trash', unread: 457 }),
  ]);

  expect(unreadInAccount(nodes)).toBe(6);
});
