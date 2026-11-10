import { MailMinus, MailPlus, Settings2 } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import type { Account } from '../../mail/core/index.ts';

/** The prefixes of the commands that edit and remove one account, one of each for every account. */
const EDIT = 'account.edit:';
const REMOVE = 'account.remove:';

/** Adding an account, and editing or removing each one the member has. */
export function accountCommands({
  accounts,
  add,
  edit,
  remove,
}: {
  accounts: readonly Account[];
  add: () => void;
  edit: (account: Account) => void;
  remove: (account: Account) => void;
}): Command[] {
  const group = 'Accounts';
  return [
    { id: 'account.add', title: 'Add account', group, icon: MailPlus, run: add },
    ...accounts.flatMap((account): Command[] => [
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
