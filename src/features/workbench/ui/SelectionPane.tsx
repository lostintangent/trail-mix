import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * On a desktop, the reader's sheet while several conversations are selected: how many, and a way to
 * let them go. This sheet holds what can be done to the selected conversations together.
 */
export function SelectionPane({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  /** The actions for the selection, where the list's header doesn't show them. */
  children: ReactNode;
}) {
  return (
    <section aria-label="Selection" {...stylex.props(styles.sheet)}>
      <div {...stylex.props(styles.middle)}>
        <Heading level={1} xstyle={styles.count}>
          {count} conversations selected
        </Heading>
        <div role="toolbar" aria-label="Selected conversations" {...stylex.props(styles.bar)}>
          {children}
        </div>
        <Button label="Clear selection" variant="ghost" onClick={onClear} />
      </div>
    </section>
  );
}

/** On a phone, the island while picking: a way to stop, how many are picked, and their actions. */
export function PickedActions({
  count,
  onCancel,
  children,
}: {
  count: number;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <IconButton
        label="Stop picking"
        icon={<Icon icon={X} />}
        variant="ghost"
        onClick={onCancel}
      />
      <span aria-live="polite" {...stylex.props(styles.picked)}>
        {count}
        <VisuallyHidden> picked</VisuallyHidden>
      </span>
      {children}
    </>
  );
}

const styles = stylex.create({
  sheet: {
    display: 'grid',
    placeItems: 'center',
    height: '100%',
    padding: spacingVars['--spacing-6'],
    backgroundColor: colorVars['--color-background-surface'],
    borderRadius: tm.paneRadius,
    boxShadow: tm.sheetEdge,
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
  middle: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacingVars['--spacing-3'],
  },
  count: {
    fontFamily: tm.serif,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
  },
  picked: {
    minWidth: tm.target,
    textAlign: 'center',
    color: colorVars['--color-text-primary'],
    fontSize: typeScaleVars['--text-body-size'],
    fontVariantNumeric: 'tabular-nums',
  },
});
