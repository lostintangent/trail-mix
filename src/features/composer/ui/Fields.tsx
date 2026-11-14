import {
  borderVars,
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { useState, type ReactNode } from 'react';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, AccountId } from '../../mail/core/index.ts';
import { AddressInput } from './AddressInput.tsx';
import { fieldStyles } from './fieldStyles.ts';
import type { AddressText } from './useWriting.ts';

/**
 * The message's fields: the From chip in its account's stamp, To, Cc and Bcc, which show once the
 * member asks for them or the message has copies, and a new message's Subject.
 */
export function Fields({
  accounts,
  account,
  typed,
  subject,
  isToFocused,
  isSheet,
  onAccount,
  onAddress,
  onSubject,
}: {
  accounts: readonly Account[];
  account: AccountId;
  typed: AddressText;
  /** A new message's Subject. A reply shows none, since it takes its parent's. */
  subject: string | undefined;
  /** Whether To takes the focus as the composer opens, as it does while it names nobody. */
  isToFocused: boolean;
  isSheet: boolean;
  onAccount: (account: Account) => void;
  onAddress: (field: keyof AddressText, text: string) => void;
  onSubject: (subject: string) => void;
}) {
  // Copies show once asked for, or once there are any, and stay while the member empties them.
  const [hasCopies, setHasCopies] = useState(false);
  if (!hasCopies && (typed.cc !== '' || typed.bcc !== '')) setHasCopies(true);
  const stamp = accounts.find(({ id }) => id === account)?.stamp;
  /** A line of the header: a label and what's typed beside it. */
  const line = (label: string, input: ReactNode) => (
    <label {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.label)}>{label}</span>
      {input}
    </label>
  );
  // Addresses are completed as they're typed.
  const addresses = (field: keyof AddressText, label: string, isFocused = false) =>
    line(
      label,
      <AddressInput
        value={typed[field]}
        onChange={(text) => onAddress(field, text)}
        isFocused={isFocused}
      />,
    );
  return (
    <div {...stylex.props(styles.fields, !isSheet && styles.onPage)}>
      <div {...stylex.props(styles.row, styles.fromRow)}>
        <div {...stylex.props(styles.fromBox)}>
          <span {...stylex.props(styles.fromLabel)}>From</span>
          <label {...stylex.props(styles.from)}>
            {stamp && <StampDot stamp={stamp} />}
            <VisuallyHidden>From</VisuallyHidden>
            <select
              value={account}
              onChange={(event) => {
                const chosen = accounts.find(({ id }) => id === event.target.value);
                if (chosen) onAccount(chosen);
              }}
              {...stylex.props(styles.select)}
            >
              {accounts.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {addresses('to', 'To', isToFocused)}
        {!hasCopies && (
          <button type="button" onClick={() => setHasCopies(true)} {...stylex.props(styles.copies)}>
            Cc Bcc
          </button>
        )}
      </div>
      {hasCopies && (
        <>
          <div {...stylex.props(styles.row)}>{addresses('cc', 'Cc')}</div>
          <div {...stylex.props(styles.row)}>{addresses('bcc', 'Bcc')}</div>
        </>
      )}
      {subject !== undefined && (
        <div {...stylex.props(styles.row)}>
          {line(
            'Subject',
            <input
              value={subject}
              onChange={(event) => onSubject(event.target.value)}
              autoComplete="off"
              spellCheck
              {...stylex.props(fieldStyles.input)}
            />,
          )}
        </div>
      )}
    </div>
  );
}

const styles = stylex.create({
  fields: {
    display: 'flex',
    flexDirection: 'column',
    borderBottomWidth: borderVars['--border-width'],
    borderBottomStyle: 'solid',
    borderBottomColor: colorVars['--color-border'],
  },
  // The rule lies as far under the fields as the text lies under it, the editor's padding.
  onPage: {
    paddingBlockEnd: spacingVars['--spacing-2'],
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minHeight: tm.target,
  },
  // On a phone the From chip has a line of its own, named as the prototype names it.
  fromRow: {
    flexWrap: { default: 'nowrap', [media.phone]: 'wrap' },
  },
  fromBox: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    flexBasis: { default: 'auto', [media.phone]: '100%' },
    minHeight: tm.target,
  },
  fromLabel: {
    display: { default: 'none', [media.phone]: 'inline' },
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-body-size'],
  },
  from: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    paddingInline: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-full'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: colorVars['--color-border'],
  },
  select: {
    appearance: 'none',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-body-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    minHeight: tm.target,
    cursor: 'pointer',
  },
  field: {
    flexGrow: 1,
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
  },
  label: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-body-size'],
  },
  copies: {
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tm.textQuiet,
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'nowrap',
    minHeight: tm.target,
    cursor: 'pointer',
  },
});
