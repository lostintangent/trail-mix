import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { colorVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { CloudOff, Hourglass } from 'lucide-react';
import { useEffect } from 'react';
import { whatFailed, type Unanswered } from '../features/mailroom/client/index.ts';
import { tm } from './theme/tokens.stylex.ts';

/**
 * The Mailroom couldn't be asked, as when the network is down or the sign-in has run out, and what
 * failed. It asks again by itself when the page is seen again or the network comes back, as after
 * a deploy that cut it off for a moment. Try again loads the page anew, which signs in again where
 * the sign-in has run out. The public demo, when it lets no more visitors in, says so instead.
 */
export function Unreachable({ failed, onTryAgain }: { failed?: unknown; onTryAgain?: () => void }) {
  useEffect(() => {
    if (!onTryAgain) return;
    const again = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) onTryAgain();
    };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('online', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      window.removeEventListener('online', again);
    };
  }, [onTryAgain]);
  const isFull = (failed as Unanswered | undefined)?.status === 429;
  return (
    <main {...stylex.props(styles.desk)}>
      <EmptyState
        headingLevel={1}
        icon={<Icon icon={isFull ? Hourglass : CloudOff} size="lg" color="secondary" />}
        title={isFull ? 'Trail Mix’s demo is full for now' : 'Trail Mix can’t reach your mail'}
        description={
          isFull
            ? 'It lets in only so many new visitors at a time. Try again in a while, or deploy a Trail Mix of your own.'
            : 'The connection or your sign-in may have lapsed.'
        }
        actions={
          <div {...stylex.props(styles.actions)}>
            <Button label="Try again" variant="primary" onClick={() => location.reload()} />
            {failed !== undefined && !isFull && (
              <p {...stylex.props(styles.failed)}>{whatFailed(failed)}</p>
            )}
          </div>
        }
      />
    </main>
  );
}

const styles = stylex.create({
  desk: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
    backgroundColor: colorVars['--color-background-body'],
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacingVars['--spacing-3'],
  },
  failed: {
    margin: 0,
    maxWidth: '36rem',
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    textAlign: 'center',
    overflowWrap: 'anywhere',
  },
});
