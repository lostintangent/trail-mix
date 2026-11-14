import { MailPlus } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import type { Account } from '../../mail/core/index.ts';

/** The prefixes of the commands that edit and remove one account, one of each for every account. */
const EDIT = 'account.edit:';
const REMOVE = 'account.remove:';
const SIGN_IN = 'account.sign-in:';

/** Whether a command acts on one account, as the menu beside its name in the sidebar lists. */
export const isAccountCommand = ({ id }: Command, account: Account) =>
  [SIGN_IN, EDIT, REMOVE].some((prefix) => id === `${prefix}${account.id}`);

/**
 * Adding an account, and editing or removing each one the member has. An account whose vendor wants
 * its member to sign in again offers that too. Erasing everything Trail Mix holds for the member
 * reaches beyond any one account, so no account's menu lists it. A demo visitor's Mailroom keeps its
 * accounts and erases itself, so there neither can be done.
 */
export function accountCommands({
  accounts,
  keeps,
  add,
  edit,
  remove,
  signIn,
  erase,
}: {
  accounts: readonly Account[];
  keeps: boolean;
  add: () => void;
  edit: (account: Account) => void;
  remove: (account: Account) => void;
  signIn: (account: Account) => void;
  erase: () => void;
}): Command[] {
  const group = 'Accounts';
  return [
    { id: 'account.add', title: 'Add account', group, icon: MailPlus, run: add },
    {
      id: 'account.erase-everything',
      title: 'Erase everything Trail Mix holds for you',
      group,
      menuIcon: 'eraser',
      isDestructive: true,
      isEnabled: !keeps,
      run: erase,
    },
    ...accounts.flatMap((account): Command[] => [
      ...(account.status === 'needs-sign-in'
        ? [
            {
              id: `${SIGN_IN}${account.id}`,
              title: `Sign in to ${account.name} again`,
              group,
              menuIcon: 'logIn',
              run: () => signIn(account),
            } satisfies Command,
          ]
        : []),
      {
        id: `${EDIT}${account.id}`,
        title: `Edit the ${account.name} account`,
        group,
        menuIcon: 'settings',
        run: () => edit(account),
      },
      {
        id: `${REMOVE}${account.id}`,
        title: `Remove the ${account.name} account`,
        group,
        menuIcon: 'mailMinus',
        isDestructive: true,
        isEnabled: !keeps,
        run: () => remove(account),
      },
    ]),
  ];
}
