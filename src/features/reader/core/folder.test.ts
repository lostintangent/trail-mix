import { expect, test } from 'bun:test';
import type { Folder, FolderRole, Message } from '../../mail/core/index.ts';
import { folderOf } from './folder.ts';

const folder = (account: string, path: string, role?: FolderRole): Folder => ({
  account,
  path,
  name: path,
  ...(role && { role }),
  unread: 0,
  total: 0,
});

const folders = [
  folder('personal', 'INBOX', 'inbox'),
  folder('personal', 'Sent', 'sent'),
  folder('personal', 'Archive', 'archive'),
  folder('personal', 'Drafts', 'drafts'),
  folder('personal', 'Projects'),
  folder('work', 'INBOX', 'inbox'),
  folder('work', 'Archive', 'archive'),
];

let uid = 0;
/** A message in a folder, on a day of November, so its place in time is plain to read. */
function message(path: string, day: number, account = 'personal'): Message {
  uid += 1;
  return {
    account,
    path,
    uidValidity: 1,
    uid,
    messageId: `<m${uid}@example.com>`,
    references: [],
    from: { email: 'ada@example.com' },
    to: [],
    cc: [],
    subject: 'Lunch',
    date: `2026-11-${String(day).padStart(2, '0')}T12:00:00Z`,
    preview: '',
    flags: { seen: true, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    conversation: 'c1',
  };
}

const named = (conversation: Message[]) => folderOf(conversation, folders)?.path;

test('a conversation lies where its newest message from someone else is, past the replies sent', () => {
  expect(named([message('INBOX', 1), message('Sent', 2)])).toBe('INBOX');
  expect(named([message('Archive', 1), message('Sent', 2), message('Drafts', 3)])).toBe('Archive');
});

test('a reply that arrives in the Inbox brings an archived conversation back there', () => {
  expect(named([message('Archive', 1), message('Sent', 2), message('INBOX', 3)])).toBe('INBOX');
});

test('the messages are read by date, whatever order they come in', () => {
  expect(named([message('INBOX', 3), message('Archive', 1)])).toBe('INBOX');
  expect(named([message('Archive', 3), message('INBOX', 1)])).toBe('Archive');
});

test('one with only the member’s own writing lies in Sent or Drafts', () => {
  expect(named([message('Sent', 1)])).toBe('Sent');
  expect(named([message('Sent', 1), message('Drafts', 2)])).toBe('Drafts');
});

test('a folder without a role is named for itself', () => {
  expect(named([message('Projects', 1)])).toBe('Projects');
});

test('a folder is the one on the message’s own account', () => {
  expect(folderOf([message('INBOX', 1, 'work')], folders)).toBe(folders[5]);
});

test('a message in a folder that isn’t listed is passed over, and alone it lies nowhere', () => {
  expect(named([message('INBOX', 1), message('Gone', 2)])).toBe('INBOX');
  expect(named([message('Gone', 1)])).toBeUndefined();
  expect(named([])).toBeUndefined();
});
