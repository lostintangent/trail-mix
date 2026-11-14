import { expect, test } from 'bun:test';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import { describeView } from './views.ts';

const account = (id: string, name: string): Account => ({
  id,
  name,
  address: `${id}@example.com`,
  provider: 'demo',
  stamp: 'teal',
  allowImagesFrom: [],
  lightPaperFrom: [],
  status: 'ready',
});
const accounts = [account('personal', 'Personal'), account('work', 'Work')];
const folders: Folder[] = [
  { account: 'work', path: 'Projects', name: 'Projects', unread: 4, total: 9 },
  { account: 'work', path: 'INBOX', name: 'INBOX', role: 'inbox', unread: 2, total: 5 },
];
const counts = { inbox: 7, drafts: 3 };
const folderView = (path: string): View => ({ in: 'folder', folder: { account: 'work', path } });

test('a folder view shows the folder’s name and unread count, and holds its account alone', () => {
  expect(describeView(folderView('Projects'), accounts, folders, counts)).toEqual({
    title: 'Projects',
    unread: 4,
    scope: accounts[1],
  });
  expect(describeView(folderView('INBOX'), accounts, folders, counts).title).toBe('Inbox');
});

test('a folder the server no longer lists shows its path, with no count', () => {
  expect(describeView(folderView('Old/Receipts'), accounts, folders, counts)).toEqual({
    title: 'Old/Receipts',
    unread: undefined,
    scope: accounts[1],
  });
});

test('the unified Inbox counts unread mail across accounts, and holds no one account', () => {
  expect(describeView({ in: 'inbox' }, accounts, folders, counts)).toEqual({
    title: 'Inbox',
    unread: 7,
  });
  expect(describeView({ in: 'drafts' }, accounts, folders, counts)).toEqual({
    title: 'Drafts',
    unread: undefined,
  });
});

test('a search has a title and no count', () => {
  expect(describeView({ in: 'search', text: 'invoice' }, accounts, folders, counts)).toEqual({
    title: 'Search',
  });
});
