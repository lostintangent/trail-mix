import { Button } from '@astryxdesign/core/Button';
import { sizeVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { MessageRef } from '../../mail/core/index.ts';
import { unsubscribe, useUnsubscribing } from './unsubscribe.ts';

/**
 * A message's offer to unsubscribe in one click, on its sheet's quiet line: the button, then
 * whether the sender took it, or the reason it didn't and a way to try again.
 */
export function Unsubscribe({ message, address }: { message: MessageRef; address: string }) {
  const standing = useUnsubscribing(address);
  const ask = () => unsubscribe(message, address);
  const told =
    standing.is === 'asking'
      ? 'Unsubscribing…'
      : standing.is === 'taken'
        ? 'Unsubscribed'
        : standing.is === 'refused'
          ? `Couldn’t unsubscribe. ${standing.reason}`
          : '';
  // The words stand in the button's place, in a status that's there from the first, so a screen
  // reader hears each change.
  return (
    <>
      {standing.is === 'offered' && (
        <Button
          label="Unsubscribe"
          tooltip={`Tell ${hostOf(address)} to stop sending you this list`}
          variant="ghost"
          size="sm"
          onClick={ask}
        />
      )}
      <span role="status" {...stylex.props(told !== '' && styles.said)}>
        {told}
      </span>
      {standing.is === 'refused' && (
        <Button label="Try again" variant="ghost" size="sm" onClick={ask} />
      )}
    </>
  );
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return 'the sender';
  }
}

const styles = stylex.create({
  // Where the button's label stood, at its size and the button's height, so the words take its
  // place and nothing moves.
  said: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: sizeVars['--size-element-sm'],
    paddingInline: spacingVars['--spacing-3'],
    fontSize: typeScaleVars['--text-label-size'],
    lineHeight: typeScaleVars['--text-label-leading'],
  },
});
