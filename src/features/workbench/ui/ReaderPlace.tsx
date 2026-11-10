import { spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { RegisteredCommandButton } from '../../commands/index.ts';

/**
 * Where the conversation shown sits in the list, as "3 of 12", and the moves to the ones either
 * side of it. The list loads a page at a time, so while it has more to load it says "3 of 100+".
 * A conversation the list no longer holds, as one just archived from Flagged may be, has no place.
 */
export function ReaderPlace({ at, of, hasMore }: { at: number; of: number; hasMore: boolean }) {
  return (
    <span {...stylex.props(styles.place)}>
      {at > 0 && (
        <span {...stylex.props(styles.count)}>
          {at} of {of}
          {hasMore ? '+' : ''}
        </span>
      )}
      <RegisteredCommandButton id="list.previous" />
      <RegisteredCommandButton id="list.next" />
    </span>
  );
}

const styles = stylex.create({
  place: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
    marginInlineStart: 'auto',
  },
  count: {
    paddingInlineEnd: spacingVars['--spacing-1'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
});
