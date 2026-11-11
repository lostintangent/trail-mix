import { colorVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { useRef } from 'react';
import { LaterTooltip } from '../../../shared/LaterTooltip.tsx';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account } from '../../mail/core/index.ts';
import { useIsCaughtUp } from '../../mailroom/client/index.ts';
import { useReach } from '../../offline/index.ts';
import { mailStatus } from './status.ts';

/**
 * How the member's mail stands, at the foot of the sidebar: a dot in the status's color and a line
 * saying it, which ends in an ellipsis where the sidebar is too narrow for all of it, and under it
 * a quiet note where there is one, such as the public demo's naming itself, which wraps instead.
 * On the rail only the dot shows, and the words wait in its tooltip.
 */
export function StatusLine({
  accounts,
  isCollapsed,
  note,
}: {
  accounts: readonly Account[];
  isCollapsed: boolean;
  note?: string;
}) {
  const status = mailStatus(accounts, useReach(), useIsCaughtUp());
  const line = useRef<HTMLParagraphElement>(null);
  if (!status) return null;
  const said = note ? `${status.label}. ${note}` : status.label;
  const shown = (
    <p ref={line} role="status" {...stylex.props(styles.line)}>
      <span {...stylex.props(styles.dot, tones[status.tone])} />
      {isCollapsed ? (
        // On the rail the words wait in the tooltip, and are read from here from the first frame.
        <VisuallyHidden>{said}</VisuallyHidden>
      ) : (
        <span {...stylex.props(styles.words)}>{status.label}</span>
      )}
    </p>
  );
  return isCollapsed ? (
    <>
      {shown}
      <LaterTooltip anchor={line} content={said} placement="end" />
    </>
  ) : (
    <div {...stylex.props(styles.status)}>
      {shown}
      {note && <p {...stylex.props(styles.note)}>{note}</p>}
    </div>
  );
}

const DOT = '6px';

const styles = stylex.create({
  status: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
  },
  line: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    gap: spacingVars['--spacing-1-5'],
    minWidth: 0,
    margin: 0,
    paddingInline: spacingVars['--spacing-2'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  // Under the status's words, past its dot.
  note: {
    margin: 0,
    paddingInlineStart: `calc(${spacingVars['--spacing-2']} + ${DOT} + ${spacingVars['--spacing-1-5']})`,
    paddingInlineEnd: spacingVars['--spacing-2'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  // A flex container can't end its own text in an ellipsis, so the words have a box of their own.
  words: {
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  dot: {
    flexShrink: 0,
    width: DOT,
    height: DOT,
    borderRadius: '50%',
    forcedColorAdjust: 'none',
  },
});

const tones = stylex.create({
  ready: { backgroundColor: colorVars['--color-success'] },
  busy: { backgroundColor: tm.textQuiet },
  trouble: { backgroundColor: colorVars['--color-error'] },
});
