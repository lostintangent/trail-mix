import {
  borderVars,
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useId, useState, type KeyboardEvent } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { nameProblem } from '../core/problems.ts';

/**
 * A folder's name being written in place, in the sidebar row it names or will name. Enter keeps it,
 * Escape lets it go, and so does leaving it unchanged or with a name it can't take. A name it can't
 * take says why under it, and nothing goes to the server.
 */
export function NameField({
  label,
  initial = '',
  depth,
  place,
  onDone,
}: {
  /** What the field is for, such as "Rename Trips", for assistive tech. */
  label: string;
  initial?: string;
  /** How many folders the folder sits inside, which sets how far in the field starts. */
  depth: number;
  /** Where the folder sits, among which folders, as the name rules read it. */
  place: Parameters<typeof nameProblem>[1];
  /** Called once, with the name to keep, or nothing to keep the folder as it was. */
  onDone: (name: string | undefined) => void;
}) {
  const [name, setName] = useState(initial);
  const [shown, setShown] = useState<string>();
  const [isDone, setDone] = useState(false);
  const problemId = useId();
  const finish = (kept: string | undefined) => {
    if (isDone) return;
    setDone(true);
    onDone(kept);
  };
  const keep = () => {
    const wanted = name.trim();
    if (wanted === initial) return finish(undefined);
    const why = nameProblem(wanted, place);
    if (why) setShown(why);
    else finish(wanted);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      keep();
    } else if (event.key === 'Escape') {
      // Escape ends the edit here, not whatever the workbench's Escape would do.
      event.preventDefault();
      event.stopPropagation();
      finish(undefined);
    }
  };
  return (
    <span {...stylex.props(styles.place, styles.depth(depth))}>
      <input
        aria-label={label}
        aria-invalid={shown !== undefined}
        aria-describedby={shown ? problemId : undefined}
        // The field opens where the member asked for it, so it takes the keys at once.
        autoFocus
        enterKeyHint="done"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setShown(undefined);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          const wanted = name.trim();
          finish(wanted !== initial && !nameProblem(wanted, place) ? wanted : undefined);
        }}
        {...stylex.props(styles.input, shown !== undefined && styles.invalid)}
      />
      {shown && (
        <span id={problemId} role="alert" {...stylex.props(styles.problem)}>
          {shown}
        </span>
      )}
    </span>
  );
}

const styles = stylex.create({
  place: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-1'],
    paddingInlineEnd: spacingVars['--spacing-1'],
  },
  // It starts where a folder's name does in its row.
  depth: (depth: number) => ({
    paddingInlineStart: `calc(${spacingVars['--spacing-2']} + 1rem + ${depth} * ${spacingVars['--spacing-3']})`,
  }),
  // As Astryx draws an input: an edge in the accent, with a muted ring, since it has the focus.
  input: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-2'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: { default: colorVars['--color-accent'], [media.forcedColors]: 'Highlight' },
    borderRadius: radiusVars['--radius-element'],
    outline: 'none',
    boxShadow: `inset 0 0 0 2px ${colorVars['--color-accent-muted']}`,
    backgroundColor: colorVars['--color-background-surface'],
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    // A phone zooms into a field whose text is smaller than 16px, so the body size holds there.
    fontSize: typeScaleVars['--text-body-size'],
  },
  invalid: {
    borderColor: { default: tm.danger, [media.forcedColors]: 'Mark' },
  },
  problem: {
    paddingInline: spacingVars['--spacing-2'],
    color: tm.danger,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
});
