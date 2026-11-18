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
import { useId, useState, type ReactNode } from 'react';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, AccountId } from '../../mail/core/index.ts';
import { isWritten } from '../core/completion.ts';
import { AddressInput } from './AddressInput.tsx';
import { fieldStyles } from './fieldStyles.ts';
import type { AddressFields, AddressName, AddressProblem } from './useWriting.ts';

/**
 * The message's fields: the From chip in its account's stamp, To, Cc and Bcc, which show once the
 * member asks for them or the message has copies, and a new message's Subject.
 */
export function Fields({
  accounts,
  account,
  fields,
  refusal,
  problem,
  subject,
  isToFocused,
  isSheet,
  onAccount,
  onAddress,
  onSubject,
}: {
  accounts: readonly Account[];
  account: AccountId;
  fields: AddressFields;
  /** The chip Send last refused, which its field selects. */
  refusal: AddressProblem | undefined;
  /** What Send refuses while a refusal stands, which its field says under its chips. */
  problem: AddressProblem | undefined;
  /** A new message's Subject. A reply shows none, since it takes its parent's. */
  subject: string | undefined;
  /** Whether To takes the focus as the composer opens, as it does while it names nobody. */
  isToFocused: boolean;
  isSheet: boolean;
  onAccount: (account: Account) => void;
  onAddress: (name: AddressName, field: AddressFields[AddressName]) => void;
  onSubject: (subject: string) => void;
}) {
  // Copies show once asked for, or once there are any, and stay while the member empties them.
  const [hasCopies, setHasCopies] = useState(false);
  if (!hasCopies && (isWritten(fields.cc) || isWritten(fields.bcc))) setHasCopies(true);
  const stamp = accounts.find(({ id }) => id === account)?.stamp;
  const id = useId();
  /** A line of the header: a label and what's written beside it, which may take several lines. */
  const line = (label: string, input: ReactNode) => (
    <div {...stylex.props(styles.field)}>
      <label htmlFor={`${id}-${label}`} {...stylex.props(styles.label)}>
        {label}
      </label>
      {input}
    </div>
  );
  const addresses = (name: AddressName, label: string, isFocused = false) =>
    line(
      label,
      <AddressInput
        id={`${id}-${label}`}
        label={label}
        field={fields[name]}
        onChange={(field) => onAddress(name, field)}
        isFocused={isFocused}
        refused={refusal?.field === name ? refusal : undefined}
        problem={problem?.field === name ? problem.text : undefined}
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
              id={`${id}-Subject`}
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
  // A line's name and its neighbors lie in its first line, however many its chips take.
  row: {
    display: 'flex',
    alignItems: 'flex-start',
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
    alignItems: 'flex-start',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
  },
  label: {
    display: 'flex',
    alignItems: 'center',
    minHeight: tm.target,
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
