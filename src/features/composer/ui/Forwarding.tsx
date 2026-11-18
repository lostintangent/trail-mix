import { Icon } from '@astryxdesign/core/Icon';
import {
  borderVars,
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Forward } from 'lucide-react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { formatListDate } from '../../conversations/index.ts';
import type { ForwardCard } from '../core/forward.ts';

/**
 * The message a forward carries under what the member writes, named on a quiet card: who sent it,
 * when and what about. The forward goes as it was sent, so the card is all the composer shows of it.
 */
export function Forwarding({ card }: { card: ForwardCard }) {
  const sender = card.from.name || card.from.email;
  return (
    <section aria-label="Forwarded message" {...stylex.props(styles.card)}>
      <span {...stylex.props(styles.icon)}>
        <Icon icon={Forward} size="sm" color="secondary" />
      </span>
      <div {...stylex.props(styles.lines)}>
        <div {...stylex.props(styles.line)}>
          <span {...stylex.props(styles.sender, styles.clipped)}>{sender}</span>
          {card.date && (
            <time dateTime={card.date} {...stylex.props(styles.quiet)}>
              {formatListDate(card.date)}
            </time>
          )}
        </div>
        <span {...stylex.props(styles.quiet, styles.clipped)}>
          {card.subject || '(no subject)'}
        </span>
      </div>
    </section>
  );
}

const styles = stylex.create({
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacingVars['--spacing-2'],
    paddingBlock: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-3'],
    borderRadius: radiusVars['--radius-element'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: colorVars['--color-border'],
    fontSize: typeScaleVars['--text-supporting-size'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
  },
  // One line tall, so the icon centers on the sender's line.
  icon: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    height: '1lh',
  },
  lines: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flexGrow: 1,
  },
  line: {
    display: 'flex',
    alignItems: 'baseline',
    gap: spacingVars['--spacing-2'],
  },
  sender: {
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  clipped: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  quiet: {
    flexShrink: 0,
    color: tm.textQuiet,
  },
});
