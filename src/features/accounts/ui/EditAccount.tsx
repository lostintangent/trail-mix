import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  borderVars,
  colorVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { stampStyles } from '../../../app/theme/stamps.ts';
import { focusRing, media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, StampColor } from '../../mail/core/index.ts';
import { VISITOR_SAID } from '../core/said.ts';
import { accountsQuery, mailroom } from '../../mailroom/client/index.ts';

/** The stamps an account can wear, in the order they're given out, and what each is called. */
const STAMPS: readonly [StampColor, string][] = [
  ['vermilion', 'Vermilion'],
  ['teal', 'Teal'],
  ['violet', 'Violet'],
  ['amber', 'Amber'],
  ['green', 'Green'],
  ['slate', 'Slate'],
];

type Kept = Pick<Account, 'name' | 'stamp'> & { fromName: string; signature: string };

/**
 * Changing what the member sees of an account: its name, its stamp, the name its mail is from and
 * its Markdown signature. The account shows the change at once, and goes back to how the Mailroom
 * holds it if the Mailroom refuses. Removing it is a step of its own, which asks first.
 */
export function EditAccount({
  account,
  onDone,
  onRemove,
  keeps,
}: {
  account: Account;
  onDone: () => void;
  onRemove: () => void;
  /** Whether the Mailroom keeps its accounts, as a demo visitor's does, so none is removed. */
  keeps: boolean;
}) {
  const queryClient = useQueryClient();
  const [kept, setKept] = useState<Kept>(() => ({
    name: account.name,
    stamp: account.stamp,
    fromName: account.fromName ?? '',
    signature: account.signature ?? '',
  }));
  const [refusal, setRefusal] = useState<string>();
  const [hasTried, setTried] = useState(false);
  const nameProblem = kept.name.trim() ? undefined : 'An account needs a name.';
  const signatureId = useId();

  const save = async () => {
    setTried(true);
    if (nameProblem) return;
    const change = changeOf(account, kept);
    if (Object.keys(change).length === 0) return onDone();
    setRefusal(undefined);
    queryClient.setQueryData(accountsQuery.queryKey, (held) =>
      held?.map((each) => (each.id === account.id ? shownAs(each, change) : each)),
    );
    try {
      await mailroom.updateAccount(account.id, change);
      onDone();
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
      setRefusal(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <form
      aria-label={`Edit ${account.name}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      {...stylex.props(styles.form)}
    >
      <TextInput
        controlXstyle={styles.control}
        label="Name"
        value={kept.name}
        onChange={(name) => setKept({ ...kept, name })}
        description="What the sidebar calls this account."
        {...(hasTried && nameProblem ? { status: { type: 'error', message: nameProblem } } : {})}
      />
      <fieldset {...stylex.props(styles.stamps)}>
        <legend {...stylex.props(styles.legend)}>Stamp</legend>
        <div role="radiogroup" aria-label="Stamp" {...stylex.props(styles.stampRow)}>
          {STAMPS.map(([stamp, label]) => (
            <label key={stamp} {...stylex.props(styles.stampTarget)}>
              <input
                type="radio"
                name="stamp"
                aria-label={label}
                checked={kept.stamp === stamp}
                onChange={() => setKept({ ...kept, stamp })}
                {...stylex.props(styles.stamp, stampStyles[stamp])}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <TextInput
        controlXstyle={styles.control}
        label="From name"
        isOptional
        value={kept.fromName}
        onChange={(fromName) => setKept({ ...kept, fromName })}
        description="Who people see your mail is from, beside your address."
      />
      <div {...stylex.props(styles.field)}>
        <label htmlFor={signatureId} {...stylex.props(styles.label)}>
          Signature <span {...stylex.props(styles.quiet)}>· Optional</span>
        </label>
        <span id={`${signatureId}-about`} {...stylex.props(styles.quiet)}>
          In Markdown, under each message you write from this account.
        </span>
        <textarea
          id={signatureId}
          aria-describedby={`${signatureId}-about`}
          rows={4}
          value={kept.signature}
          onChange={(event) => setKept({ ...kept, signature: event.target.value })}
          {...stylex.props(styles.textarea)}
        />
      </div>
      {refusal && (
        <div role="alert">
          <Banner status="error" title="The change wasn’t kept." description={refusal} />
        </div>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button type="submit" variant="primary" label="Save" />
        <Button label="Cancel" variant="ghost" onClick={onDone} />
        <span {...stylex.props(styles.apart)}>
          {keeps && (
            <span id={`${signatureId}-kept`} {...stylex.props(styles.quiet)}>
              {VISITOR_SAID.keeps}
            </span>
          )}
          <Button
            label="Remove account…"
            variant="ghost"
            isDisabled={keeps}
            aria-describedby={keeps ? `${signatureId}-kept` : undefined}
            onClick={onRemove}
          />
        </span>
      </div>
    </form>
  );
}

/** What changed, and only that, as the Mailroom takes it. An empty From name removes it. */
function changeOf(account: Account, kept: Kept) {
  const name = kept.name.trim();
  const fromName = kept.fromName.trim();
  const signature = kept.signature.trim();
  return {
    ...(name !== account.name ? { name } : {}),
    ...(kept.stamp !== account.stamp ? { stamp: kept.stamp } : {}),
    ...(fromName !== (account.fromName ?? '') ? { fromName } : {}),
    ...(signature !== (account.signature ?? '') ? { signature } : {}),
  };
}

/** An account as it shows once the change is kept, as the Mailroom keeps it. */
function shownAs(account: Account, change: ReturnType<typeof changeOf>): Account {
  const { fromName, ...rest } = { ...account, ...change };
  return { ...rest, ...(fromName ? { fromName } : {}) };
}

const styles = stylex.create({
  // Astryx draws a field at a fixed height, which a finger needs at 44px.
  control: {
    height: tm.target,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    margin: 0,
  },
  stamps: {
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  legend: {
    padding: 0,
    marginBottom: spacingVars['--spacing-1'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  stampRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-1'],
  },
  // A whole target to press, around a stamp the size of the sidebar's.
  stampTarget: {
    display: 'grid',
    placeItems: 'center',
    width: tm.target,
    height: tm.target,
    cursor: 'pointer',
  },
  stamp: {
    appearance: 'none',
    width: spacingVars['--spacing-4'],
    height: spacingVars['--spacing-4'],
    margin: 0,
    borderRadius: radiusVars['--radius-inner'],
    cursor: 'pointer',
    outline: {
      default: null,
      ':checked': `${focusVars['--focus-outline-width']} solid ${colorVars['--color-text-primary']}`,
      ':focus-visible': focusRing.line,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
    outlineOffset: focusRing.outside,
  },
  // Astryx's text area brings plural messages the app's formatter can't read, so this one is ours,
  // drawn as Astryx draws its fields.
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-1'],
  },
  label: {
    color: colorVars['--color-text-secondary'],
    fontWeight: fontWeightVars['--font-weight-medium'],
  },
  quiet: {
    color: tm.textQuiet,
    fontWeight: fontWeightVars['--font-weight-normal'],
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  textarea: {
    boxSizing: 'border-box',
    width: '100%',
    padding: spacingVars['--spacing-2'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: colorVars['--color-border-emphasized'],
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: colorVars['--color-background-surface'],
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-code'],
    // A phone zooms into a field whose text is smaller than 16px, so the body size holds there.
    fontSize: typeScaleVars['--text-body-size'],
    resize: 'vertical',
    outline: { default: null, ':focus-visible': focusRing.line },
    outlineOffset: focusRing.outside,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-2'],
  },
  apart: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    marginInlineStart: 'auto',
  },
});
