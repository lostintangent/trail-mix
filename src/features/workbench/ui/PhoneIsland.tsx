import { colorVars, radiusVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * On a phone, a pane's actions float on paper at the bottom of the screen, within reach of a thumb.
 * Wider screens keep their actions where they belong in the pane, so the island isn't there.
 */
export function PhoneIsland({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="toolbar" aria-label={label} {...stylex.props(styles.island)}>
      {children}
    </div>
  );
}

const styles = stylex.create({
  island: {
    display: { default: 'none', [media.phone]: 'flex' },
    position: 'absolute',
    // It hugs what it holds, from the start edge.
    insetInlineStart: spacingVars['--spacing-3'],
    bottom: tm.safeBottom,
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    padding: spacingVars['--spacing-1'],
    borderRadius: radiusVars['--radius-container'],
    backgroundColor: colorVars['--color-background-card'],
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}, 0 10px 24px -10px ${tm.shade}`,
    outline: { default: null, [media.forcedColors]: '1px solid CanvasText' },
  },
});
