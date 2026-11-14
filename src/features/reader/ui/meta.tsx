import {
  borderVars,
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { Icon } from '@astryxdesign/core/Icon';
import * as stylex from '@stylexjs/stylex';
import { ExternalLink } from 'lucide-react';
import { stampStyles } from '../../../app/theme/stamps.ts';
import { focusRing, media } from '../../../app/theme/tokens.stylex.ts';
import type { Account } from '../../mail/core/index.ts';
import { threadStyles } from './layout.ts';

/**
 * The line under a conversation's or a bundle's heading, once it has come: the account's stamp,
 * what it holds, and where it lives on GitHub. Only the readers that load after the first screen
 * draw it, so it loads with them.
 */
export function MetaLine({
  account,
  says,
  onGitHub,
}: {
  account: Account | undefined;
  says: string[];
  onGitHub: { address: string; name: string } | undefined;
}) {
  return (
    <p {...stylex.props(threadStyles.meta, onGitHub && styles.wrapping)}>
      {account && <span aria-hidden {...stylex.props(styles.stamp, stampStyles[account.stamp])} />}
      <span>
        {says.join(' · ')}
        {onGitHub && ' · '}
      </span>
      {onGitHub && (
        <a
          href={onGitHub.address}
          target="_blank"
          rel="noopener noreferrer"
          {...stylex.props(styles.link)}
        >
          {onGitHub.name} on GitHub
          <Icon icon={ExternalLink} size="xsm" xstyle={styles.linkIcon} />
        </a>
      )}
    </p>
  );
}

/** A count of something, as "1 message" or "3 threads". */
export const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const styles = stylex.create({
  // The account's stamp, leading the line.
  stamp: {
    width: spacingVars['--spacing-2'],
    height: spacingVars['--spacing-2'],
    flexShrink: 0,
    borderRadius: radiusVars['--radius-inner'],
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
  // A line that holds a link wraps between its parts.
  wrapping: {
    flexWrap: 'wrap',
    columnGap: spacingVars['--spacing-1-5'],
    rowGap: 0,
  },
  // Where the conversation lives on another site, as a bundle's repository or a thread on GitHub.
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    color: colorVars['--color-text-accent'],
    fontWeight: fontWeightVars['--font-weight-medium'],
    textDecoration: { default: 'none', ':hover': 'underline' },
    borderRadius: radiusVars['--radius-inner'],
    outline: {
      default: null,
      ':focus-visible': focusRing.line,
    },
    outlineOffset: focusRing.outside,
  },
  linkIcon: {
    color: 'inherit',
  },
});
