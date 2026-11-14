import { expect, test } from 'bun:test';
import { accentCommands } from '../../../app/theme/commands.ts';
import {
  commandFor,
  matching,
  problemsOf,
  shortcutsOf,
  type Command,
} from '../../commands/index.ts';
import { triageCommands } from '../../conversations/index.ts';
import { viewCommands } from '../../folders/index.ts';
import { sendCommands } from '../../outbox/index.ts';
import type { Account, Folder } from '../../mail/core/index.ts';
import { workbenchCommands } from './commands.ts';

const account = (id: string, name: string): Account =>
  ({ id, name, stamp: 'teal', address: `${id}@trailmix.test` }) as Account;
const folder = (accountId: string, path: string, role?: Folder['role']): Folder => ({
  account: accountId,
  path,
  name: path,
  role,
  unread: 0,
  total: 0,
});
const accounts = [account('personal', 'Personal'), account('work', 'Work')];
const folders = [
  folder('personal', 'INBOX', 'inbox'),
  folder('personal', 'Archive', 'archive'),
  folder('personal', 'Drafts', 'drafts'),
  folder('work', 'INBOX', 'inbox'),
  folder('work', 'Receipts'),
  { ...folder('work', 'Projects/Toy Box'), name: 'Toy Box', parent: 'Projects' },
];
const nothing = () => {};

/** The registry the workbench gathers, with something selected and somewhere to go back from. */
function registry(isUnread: boolean): Command[] {
  return [
    ...triageCommands({ accounts, folders, isFlagged: false, isUnread, onTriage: nothing }),
    ...workbenchCommands({
      next: nothing,
      previous: nothing,
      back: nothing,
      undo: nothing,
      focusSearch: nothing,
      unread: { isOn: false, toggle: nothing },
      fold: { isFolded: false, toggle: nothing },
      openSettings: nothing,
      showShortcuts: nothing,
    }),
    ...viewCommands(accounts, folders, nothing),
    ...sendCommands({ onSend: nothing }),
    ...accentCommands('#c2185b', nothing, nothing),
  ];
}

/** The key press a shortcut asks for, as a keyboard on an Apple platform would send it. */
function pressFor(shortcut: string) {
  const parts = shortcut.split('+');
  const key = parts.at(-1)!;
  const shiftKey = parts.includes('Shift') || ['#', '?'].includes(key);
  const isLetter = /^[a-z]$/i.test(key);
  return {
    key: isLetter ? (shiftKey ? key.toUpperCase() : key.toLowerCase()) : key,
    shiftKey,
    metaKey: parts.includes('Mod'),
    ctrlKey: false,
    altKey: false,
  };
}

test('the workbench’s registry has no id twice and no key on two commands', () => {
  for (const isUnread of [true, false]) expect(problemsOf(registry(isUnread))).toEqual([]);
});

test('every key resolves to its own command, and typing a command’s title finds it', () => {
  for (const isUnread of [true, false]) {
    const commands = registry(isUnread);
    for (const command of commands.filter(({ isEnabled }) => isEnabled !== false)) {
      const words = command.title.split(' ');
      expect(matching(commands, command.title)).toContain(command);
      const start = words.slice(0, 2).join(' ').toLowerCase();
      expect(matching(commands, start)).toContain(command);
      if (command.shortcut) {
        for (const shortcut of shortcutsOf(command.shortcut)) {
          expect(commandFor(commands, pressFor(shortcut), true)?.id).toBe(command.id);
        }
      }
    }
  }
});

test('the keys the prototypes promise are all there', () => {
  const keys = new Set(
    [...registry(true), ...registry(false)].flatMap(({ shortcut }) =>
      shortcut ? shortcutsOf(shortcut) : [],
    ),
  );
  for (const key of ['E', '#', 'S', 'Shift+I', 'Shift+U', 'Z', 'J', 'K', 'Escape', '?', 'Mod+K']) {
    expect(keys).toContain(key);
  }
});
