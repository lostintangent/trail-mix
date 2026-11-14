import { Button } from '@astryxdesign/core/Button';
import {
  borderVars,
  colorVars,
  fontWeightVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useId } from 'react';
import { ReaderPage } from '../../../app/theme/ReaderPage.tsx';
import type { Account, AccountId } from '../../mail/core/index.ts';
import { AddAccount } from './AddAccount.tsx';
import { EditAccount } from './EditAccount.tsx';
import { SignInAgain, vendorOf } from './SignInAgain.tsx';
import { VISITOR_SAID } from '../core/said.ts';
import { formStyles } from './formStyles.ts';

/**
 * An account page the workbench shows in place of a conversation: adding one, or editing one,
 * signing in again at once when asked to.
 */
export type AccountPageOf =
  { as: 'add' } | { as: 'edit'; account: AccountId; isSigningIn?: boolean };

/**
 * Adding or editing an account, on the reader's sheet, where a phone slides to it on its track. An
 * account removed meanwhile, here or on another device, closes its page. Below an account's own
 * settings, set apart from them, lies the way to erase all of Trail Mix, where a member already
 * goes to take things away. A demo visitor can do neither, nor add an account, and is told why,
 * and how to have a Trail Mix of their own.
 */
export function AccountPage({
  page,
  accounts,
  isVisitor,
  onClose,
  onRemove,
  onErase,
}: {
  page: AccountPageOf;
  accounts: readonly Account[];
  /** Whether this is a visitor's Mailroom on the public demo. */
  isVisitor: boolean;
  onClose: () => void;
  onRemove: (account: Account) => void;
  /** Asks first, then erases everything Trail Mix holds for the member. */
  onErase: () => void;
}) {
  const eraseId = useId();
  const editing = page.as === 'edit' ? accounts.find(({ id }) => id === page.account) : undefined;
  if (page.as === 'edit' && !editing) return null;
  const vendor = editing && vendorOf(editing);
  return (
    <ReaderPage title={editing ? editing.name : 'Add an account'}>
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
          keeps={isVisitor}
        />
      ) : isVisitor ? (
        <div {...stylex.props(styles.invitation)}>
          <p {...stylex.props(styles.said)}>{VISITOR_SAID.invitation}</p>
          <div>
            <Button label="Back to the mail" variant="ghost" onClick={onClose} />
          </div>
        </div>
      ) : (
        <AddAccount accounts={accounts} onAdded={onClose} onCancel={onClose} />
      )}
      {editing && (
        <section aria-labelledby={eraseId} {...stylex.props(styles.everything)}>
          <h2 id={eraseId} {...stylex.props(styles.everythingTitle)}>
            All of Trail Mix
          </h2>
          <p id={`${eraseId}-about`} {...stylex.props(formStyles.quiet)}>
            {isVisitor
              ? VISITOR_SAID.erases
              : 'Erase every account and everything Trail Mix holds for you, on every device.'}
          </p>
          <div>
            <Button
              label="Erase everything…"
              variant="ghost"
              isDisabled={isVisitor}
              aria-describedby={`${eraseId}-about`}
              onClick={onErase}
            />
          </div>
        </section>
      )}
    </ReaderPage>
  );
}

const styles = stylex.create({
  // Ruled off from the account above it, since it reaches beyond that account.
  everything: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    marginTop: spacingVars['--spacing-4'],
    paddingTop: spacingVars['--spacing-4'],
    borderTopWidth: borderVars['--border-width'],
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
  },
  everythingTitle: {
    margin: 0,
    fontSize: typeScaleVars['--text-body-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    color: colorVars['--color-text-primary'],
  },
  invitation: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-3'],
  },
  said: {
    margin: 0,
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
  },
});
