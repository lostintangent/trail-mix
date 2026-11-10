import { colorVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account } from '../../mail/core/index.ts';
import { mailStatus } from './status.ts';

/**
 * How the member's mail stands, at the foot of the sidebar: a dot in the status's color and a line
 * saying it. On the rail only the dot shows, and the line waits in its tooltip.
 */
export function StatusLine({
  accounts,
  isCollapsed,
}: {
  accounts: readonly Account[];
  isCollapsed: boolean;
}) {
  const status = mailStatus(accounts);
  if (!status) return null;
  const line = (
    <p role="status" {...stylex.props(styles.line)}>
      <span {...stylex.props(styles.dot, tones[status.tone])} />
      {isCollapsed ? <VisuallyHidden>{status.label}</VisuallyHidden> : status.label}
    </p>
  );
  return isCollapsed ? (
    <Tooltip content={status.label} placement="end">
      {line}
    </Tooltip>
  ) : (
    line
  );
}

const styles = stylex.create({
  line: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1-5'],
    minWidth: 0,
    margin: 0,
    paddingInline: spacingVars['--spacing-2'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  dot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    forcedColorAdjust: 'none',
  },
});

const tones = stylex.create({
  ready: { backgroundColor: colorVars['--color-success'] },
  busy: { backgroundColor: tm.textQuiet },
  trouble: { backgroundColor: colorVars['--color-error'] },
});
