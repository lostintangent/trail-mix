import { Dialog } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { Kbd } from '@astryxdesign/core/Kbd';
import { colorVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useCommands } from '../registry.ts';

/** The shortcut sheet, opened with ?: every command that has a key, by group. */
export function ShortcutSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const keyed = useCommands().filter(({ shortcut }) => shortcut);
  const groups = Map.groupBy(keyed, ({ group }) => group);
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => !open && onClose()} width={420}>
      <Heading level={2}>Keyboard shortcuts</Heading>
      {[...groups].map(([group, commands]) => (
        <section key={group} aria-label={group} {...stylex.props(styles.group)}>
          <h3 {...stylex.props(styles.groupName)}>{group}</h3>
          <dl {...stylex.props(styles.keys)}>
            {commands.map(({ id, title, shortcut }) => (
              <div key={id} {...stylex.props(styles.key)}>
                <dt>{title}</dt>
                <dd {...stylex.props(styles.cap)}>
                  <Kbd keys={shortcut!.toLowerCase()} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}

const styles = stylex.create({
  group: {
    marginTop: spacingVars['--spacing-3'],
  },
  groupName: {
    margin: 0,
    marginBottom: spacingVars['--spacing-1'],
    color: colorVars['--color-text-secondary'],
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  keys: {
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-1'],
  },
  key: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cap: {
    margin: 0,
  },
});
