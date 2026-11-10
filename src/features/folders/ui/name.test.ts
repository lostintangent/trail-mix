import { expect, test } from 'bun:test';
import type { Folder } from '../../mail/core/index.ts';
import { folderName } from './name.ts';

const folder = (name: string, role?: Folder['role']): Folder => ({
  account: 'work',
  path: name,
  name,
  ...(role && { role }),
  unread: 0,
  total: 0,
});

test('a folder with a role goes by its role, and any other by its own name', () => {
  expect(folderName(folder('INBOX', 'inbox'))).toBe('Inbox');
  expect(folderName(folder('Sent Items', 'sent'))).toBe('Sent');
  expect(folderName(folder('Receipts'))).toBe('Receipts');
});
