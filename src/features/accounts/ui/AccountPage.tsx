import { spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, AccountId } from '../../mail/core/index.ts';
import { AddAccount } from './AddAccount.tsx';
import { EditAccount } from './EditAccount.tsx';
import { SignInAgain, vendorOf } from './SignInAgain.tsx';

/**
 * An account page the workbench shows in place of a conversation: adding one, or editing one,
 * signing in again at once when asked to.
 */
export type AccountPageOf =
  { as: 'add' } | { as: 'edit'; account: AccountId; isSigningIn?: boolean };

/**
 * Adding or editing an account, on the reader's sheet, where a phone slides to it on its track. An
 * account removed meanwhile, here or on another device, closes its page.
 */
export function AccountPage({
  page,
  accounts,
  onClose,
  onRemove,
}: {
  page: AccountPageOf;
  accounts: readonly Account[];
  onClose: () => void;
  onRemove: (account: Account) => void;
}) {
  const editing = page.as === 'edit' ? accounts.find(({ id }) => id === page.account) : undefined;
  if (page.as === 'edit' && !editing) return null;
  const vendor = editing && vendorOf(editing);
  return (
    <section aria-labelledby="account-page-title" {...stylex.props(styles.page)}>
      <h1 id="account-page-title" {...stylex.props(styles.title)}>
        {editing ? editing.name : 'Add an account'}
      </h1>
      {editing && vendor && editing.status === 'needs-sign-in' && (
        <SignInAgain
          // Its own key, apart from the editor's beside it, so each account's sign-in starts afresh.
          key={`${editing.id}:sign-in`}
          account={editing}
          vendor={vendor}
          isStarting={page.as === 'edit' && page.isSigningIn}
        />
      )}
      {editing ? (
        <EditAccount
          key={editing.id}
          account={editing}
          onDone={onClose}
          onRemove={() => onRemove(editing)}
        />
      ) : (
        <AddAccount accounts={accounts} onAdded={onClose} onCancel={onClose} />
      )}
    </section>
  );
}

const styles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    width: '100%',
    maxWidth: tm.measure,
    paddingInline: {
      default: spacingVars['--spacing-6'],
      [media.phone]: spacingVars['--spacing-3'],
    },
    paddingBottom: spacingVars['--spacing-6'],
  },
  title: {
    margin: 0,
    fontFamily: tm.serif,
    fontSize: typeScaleVars['--text-heading-1-size'],
    fontWeight: typeScaleVars['--text-heading-1-weight'],
    lineHeight: typeScaleVars['--text-heading-1-leading'],
    overflowWrap: 'anywhere',
  },
});
