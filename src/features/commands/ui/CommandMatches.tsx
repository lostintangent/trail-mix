import { Kbd } from '@astryxdesign/core/Kbd';
import {
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { matching } from '../core/registry.ts';
import { useCommands } from '../registry.ts';

/** How many commands the palette shows at once, best first. */
const SHOWN = 8;

/**
 * The palette: the commands that match what's been typed in the search box, each with its key, to
 * run with a click. With nothing typed, it lists every command that can run now.
 */
export function CommandMatches({ text, onDone }: { text: string; onDone: () => void }) {
  const found = matching(useCommands(), text).slice(0, SHOWN);
  if (found.length === 0) return null;
  return (
    <ul aria-label="Commands" {...stylex.props(styles.list)}>
      {found.map((command) => (
        <li key={command.id}>
          <button
            type="button"
            onClick={() => {
              onDone();
              void command.run();
            }}
            {...stylex.props(styles.command)}
          >
            <span {...stylex.props(styles.title)}>{command.title}</span>
            {command.shortcut && <Kbd keys={command.shortcut.toLowerCase()} />}
          </button>
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
      ':focus-visible': colorVars['--color-overlay-hover'],
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
});
