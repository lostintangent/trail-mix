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
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, AccountId } from '../../mail/core/index.ts';
import { AddAccount } from './AddAccount.tsx';
import { EditAccount } from './EditAccount.tsx';
import { SignInAgain, vendorOf } from './SignInAgain.tsx';
import { VISITOR_SAID } from '../core/said.ts';

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
  isVisitor = false,
  onClose,
  onRemove,
  onErase,
}: {
  page: AccountPageOf;
  accounts: readonly Account[];
  /** Whether this is a visitor's Mailroom on the public demo. */
  isVisitor?: boolean;
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
          <p id={`${eraseId}-about`} {...stylex.props(styles.quiet)}>
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
  quiet: {
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
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
