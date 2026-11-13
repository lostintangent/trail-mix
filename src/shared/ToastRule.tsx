import * as stylex from '@stylexjs/stylex';
import { tm } from '../app/theme/tokens.stylex.ts';

/**
 * The short upright rule that sets a toast's action off from its close, as the sidebar's foot
 * sets its gear off from the name.
 */
export function ToastRule() {
  return <span aria-hidden {...stylex.props(styles.rule)} />;
}

const styles = stylex.create({
  // Drawn as an edge rather than a fill, so forced colors keep it in their own ink.
  rule: {
    flexShrink: 0,
    height: '1rem',
    borderInlineStartWidth: '1px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tm.rule,
  },
});
