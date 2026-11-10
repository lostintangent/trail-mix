import { expect, test } from 'bun:test';
import { commandFor, matching, problemsOf, type CommandLike } from './registry.ts';

const command = (
  id: string,
  title: string,
  shortcut?: string,
  isEnabled?: boolean,
): CommandLike => ({
  id,
  title,
  group: 'Conversation',
  shortcut,
  isEnabled,
});
const press = (key: string, shiftKey = false) => ({
  key,
  shiftKey,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
});

const archive = command('archive', 'Archive', 'E');
const unread = command('unread', 'Mark unread', 'Shift+U');
const inbox = command('inbox', 'Go to Inbox');
const flag = command('flag', 'Flag', 'S', false);

test('a key runs the command that has it, and nothing when that command can’t run now', () => {
  expect(commandFor([archive, unread, flag], press('e'), true)).toBe(archive);
  expect(commandFor([archive, unread, flag], press('U', true), true)).toBe(unread);
  expect(commandFor([archive, unread, flag], press('s'), true)).toBeUndefined();
});

test('the palette lists every command that can run, and narrows by word prefixes, starts first', () => {
  const marked = command('read', 'Mark read');
  expect(matching([archive, unread, inbox, flag], '')).toEqual([archive, unread, inbox]);
  expect(matching([inbox, archive, marked, unread], 'ma r')).toEqual([marked]);
  expect(matching([inbox, command('archive-folder', 'Go to Archive'), archive], 'arch')).toEqual([
    archive,
    command('archive-folder', 'Go to Archive'),
  ]);
});

test('a registry with a duplicate id or two commands on one key says so', () => {
  expect(problemsOf([archive, unread, inbox])).toEqual([]);
  expect(problemsOf([archive, command('archive', 'Archive again')])).toEqual([
    'Two commands are called archive.',
  ]);
  expect(problemsOf([archive, command('delete', 'Delete', 'e')])).toEqual([
    'e is the key of both archive and delete.',
  ]);
});
