import { Kbd } from '@astryxdesign/core/Kbd';
import {
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useLayoutEffect, useState } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { matching } from '../core/registry.ts';
import { focusSearch, useCommands, type Command } from '../registry.ts';

/** How many commands the palette shows at once, best first. */
const SHOWN = 8;

/** The keys the field the palette lies under hands on to it, which it says it took. */
export type PaletteKeys = {
  current: ((key: 'ArrowUp' | 'ArrowDown' | 'Enter') => boolean) | undefined;
};

/**
 * The palette: the commands that match what's been typed in the search box, each with its key. With
 * nothing typed, it lists every command that can run now. Focus stays in the field, which hands on
 * the arrow keys to move the highlight and Enter to run the highlighted command, and a click runs
 * any of them.
 */
export function CommandMatches({
  text,
  onDone,
  keys,
  id,
  onActive,
}: {
  text: string;
  onDone: () => void;
  keys: PaletteKeys;
  /** The list's id, which the field controls. Each option's id adds its place. */
  id: string;
  /** The highlighted option's id, for the field's `aria-activedescendant`. */
  onActive: (option: string | undefined) => void;
}) {
  // The command that opens the palette does nothing from inside it.
  const found = matching(useCommands(), text)
    .filter(({ run }) => run !== focusSearch)
    .slice(0, SHOWN);
  // The best match is highlighted again whenever the text changes.
  const [highlight, setHighlight] = useState({ text, at: 0 });
  const at =
    found.length === 0
      ? -1
      : highlight.text === text
        ? Math.min(highlight.at, found.length - 1)
        : 0;
  const run = (command: Command) => {
    onDone();
    void command.run();
  };
  useLayoutEffect(() => {
    keys.current = (key) => {
      const command = found[at];
      if (!command) return false;
      if (key === 'Enter') run(command);
      else
        setHighlight({
          text,
          at:
            key === 'ArrowDown' ? (at + 1) % found.length : (at - 1 + found.length) % found.length,
        });
      return true;
    };
  });
  useLayoutEffect(() => () => void (keys.current = undefined), [keys]);
  useEffect(() => onActive(at >= 0 ? `${id}-${at}` : undefined), [at, id, onActive]);

  if (found.length === 0) return null;
  return (
    <ul role="listbox" id={id} aria-label="Commands" {...stylex.props(styles.list)}>
      {found.map((command, place) => (
        <li
          key={command.id}
          id={`${id}-${place}`}
          role="option"
          aria-selected={place === at}
          // The field keeps the focus, so typing goes on while the pointer picks.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(command)}
          {...stylex.props(styles.command, place === at && styles.highlighted)}
        >
          <span {...stylex.props(styles.title)}>{command.title}</span>
          {command.shortcut && <Kbd keys={command.shortcut.toLowerCase()} />}
        </li>
      ))}
    </ul>
  );
}

const styles = stylex.create({
  list: {
    listStyle: 'none',
    margin: 0,
    padding: spacingVars['--spacing-1'],
    display: 'flex',
    flexDirection: 'column',
  },
  command: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    width: '100%',
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-2'],
    border: 'none',
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: {
      default: 'transparent',
      ':hover': colorVars['--color-overlay-hover'],
    },
    color: colorVars['--color-text-primary'],
    font: 'inherit',
    fontSize: typeScaleVars['--text-body-size'],
    textAlign: 'start',
    cursor: 'pointer',
  },
  title: {
    flexGrow: 1,
    minWidth: 0,
  },
  // The highlighted command, which Enter runs, in the field's own ring of ink.
  highlighted: {
    backgroundColor: colorVars['--color-overlay-hover'],
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-accent']}`,
    outline: { default: null, [media.forcedColors]: '2px solid Highlight' },
  },
});
