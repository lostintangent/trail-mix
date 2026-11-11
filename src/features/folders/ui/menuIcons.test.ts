import { expect, test } from 'bun:test';
import { accountCommands } from '../../accounts/index.ts';
import { MENU_ICON_NAMES, type Command } from '../../commands/index.ts';
import type { Account, Folder } from '../../mail/core/index.ts';
import { sourceCommand } from '../../reader/index.ts';
import { folderActions, folderCommands } from './commands.ts';
import { MENU_ICONS, menuIconOf } from './menuIcons.ts';

const account = (id: string, status: Account['status'] = 'ready'): Account => ({
  id,
  name: id,
  address: `${id}@example.com`,
  provider: 'demo',
  stamp: 'teal',
  allowImagesFrom: [],
  lightPaperFrom: [],
  status,
});
const accounts = [account('personal'), account('work', 'needs-sign-in')];
const folder: Folder = { account: 'personal', path: 'Trips', name: 'Trips', unread: 0, total: 0 };
const nothing = () => {};

test('every icon a command may name is one the menus bring, and they bring no other', () => {
  expect(Object.keys(MENU_ICONS).toSorted()).toEqual([...MENU_ICON_NAMES].toSorted());
  for (const name of MENU_ICON_NAMES) expect(MENU_ICONS[name]).toBeDefined();
});

test('every command with an icon resolves to one in a menu, whether its own or named', () => {
  const commands: Command[] = [
    ...accountCommands({
      accounts,
      add: nothing,
      edit: nothing,
      remove: nothing,
      signIn: nothing,
      erase: nothing,
    }),
    ...folderCommands({
      accounts,
      folders: [folder],
      view: { in: 'folder', folder },
      edit: nothing,
      remove: nothing,
    }),
    ...folderActions({ folder, accounts, folders: [folder], edit: nothing, remove: nothing }),
    sourceCommand(nothing),
  ];
  const named = commands.filter(({ menuIcon }) => menuIcon !== undefined);
  expect(named.map(({ id }) => id)).toContain('account.sign-in:work');
  expect(named.length).toBeGreaterThan(6);
  for (const command of commands.filter(({ icon, menuIcon }) => icon ?? menuIcon)) {
    expect({ id: command.id, drawn: menuIconOf(command) !== undefined }).toEqual({
      id: command.id,
      drawn: true,
    });
  }
});

test('a command’s own icon is the one a menu draws, before any it names', () => {
  const own = MENU_ICONS.code;
  expect(
    menuIconOf({ id: 'x', title: 'X', group: 'G', icon: own, menuIcon: 'eraser', run: nothing }),
  ).toBe(own);
  expect(menuIconOf({ id: 'x', title: 'X', group: 'G', run: nothing })).toBeUndefined();
});
