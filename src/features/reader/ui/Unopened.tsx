import { Button } from '@astryxdesign/core/Button';
import * as stylex from '@stylexjs/stylex';
import { bareSubject } from '../core/subject.ts';
import { threadStyles } from './layout.ts';

/**
 * A conversation that couldn't be opened, under its subject as the list has it. With no network,
 * one this device didn't keep opens once the network is back, by itself. Otherwise the member can
 * ask again.
 */
export function ConversationUnopened({
  subject,
  isOffline,
  onTryAgain,
}: {
  subject: string | undefined;
  isOffline: boolean;
  onTryAgain: () => void;
}) {
  return (
    <div {...stylex.props(threadStyles.thread)}>
      {subject !== undefined && (
        <h1 {...stylex.props(threadStyles.subject)}>{bareSubject(subject)}</h1>
      )}
      <p role="alert" {...stylex.props(threadStyles.meta)}>
        {isOffline ? (
          'This conversation isn’t on this device yet. It opens once you’re back online.'
        ) : (
          <>
            This conversation could not be opened.
            <Button label="Try again" variant="ghost" size="sm" onClick={onTryAgain} />
          </>
        )}
      </p>
    </div>
  );
}
