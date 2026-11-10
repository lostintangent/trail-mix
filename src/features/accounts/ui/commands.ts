import { LogIn, MailMinus, MailPlus, Settings2 } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import type { Account } from '../../mail/core/index.ts';

/** The prefixes of the commands that edit and remove one account, one of each for every account. */
const EDIT = 'account.edit:';
const REMOVE = 'account.remove:';
const SIGN_IN = 'account.sign-in:';

/**
 * Adding an account, and editing or removing each one the member has. An account whose vendor wants
 * its member to sign in again offers that too.
 */
export function accountCommands({
  accounts,
  add,
  edit,
  remove,
  signIn,
}: {
  accounts: readonly Account[];
  add: () => void;
  edit: (account: Account) => void;
  remove: (account: Account) => void;
  signIn: (account: Account) => void;
}): Command[] {
  const group = 'Accounts';
  return [
    { id: 'account.add', title: 'Add account', group, icon: MailPlus, run: add },
    ...accounts.flatMap((account): Command[] => [
      ...(account.status === 'needs-sign-in'
        ? [
            {
              id: `${SIGN_IN}${account.id}`,
              title: `Sign in to ${account.name} again`,
              group,
              icon: LogIn,
              run: () => signIn(account),
            },
          ]
        : []),
      {
        id: `${EDIT}${account.id}`,
        title: `Edit the ${account.name} account`,
        group,
        icon: Settings2,
        run: () => edit(account),
      },
      {
        id: `${REMOVE}${account.id}`,
        title: `Remove the ${account.name} account`,
        group,
        icon: MailMinus,
        run: () => remove(account),
      },
    ]),
  ];
}
