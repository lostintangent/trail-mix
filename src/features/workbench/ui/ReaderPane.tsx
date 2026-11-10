import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { borderVars, colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, MailOpen } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, ConversationId } from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';

/**
 * The reader, with its sanitizer, loads apart from the first rows, which don't need it. Soon after
 * the list shows a conversation to open, it loads while the browser is idle, ready for the click.
 */
type ReaderModule = typeof import('../../reader/index.ts');
let loaded: ReaderModule | undefined;
const loadReader = async () => (loaded ??= await import('../../reader/index.ts'));
const Reader = lazy(() => {
  const ready = loaded && { default: loaded.Reader };
  if (!ready) return loadReader().then(({ Reader }) => ({ default: Reader }));
  // Loaded code comes through a thenable that settles at once, which React renders without
  // suspending, so the first open doesn't wait out the pause React gives a Suspense reveal.
  const settled = { then: (resolve: (module: typeof ready) => void) => resolve(ready) };
  return settled as unknown as Promise<typeof ready>;
});

/**
 * The reader's sheet, where an open conversation lies. On a phone it fills the screen, with a way
 * back to the list at its top.
 */
export function ReaderPane({
  selected,
  accounts,
  upcoming,
  onShown,
  onBack,
}: {
  selected: ConversationId | undefined;
  accounts: readonly Account[];
  /** The conversations the member may open next, which the reader prepares while idle. */
  upcoming: ConversationId[];
  /**
   * Called each time the reader starts showing a conversation, which is what opening it means. A
   * conversation the selection passes on its way elsewhere is never shown.
   */
  onShown?: (conversation: ConversationId) => void;
  onBack: () => void;
}) {
  const shown = useRestingSelection(selected);
  const { data: conversation } = useQuery({
    ...conversationQuery(shown ?? ''),
    enabled: shown !== undefined,
  });
  const account = accounts.find(({ id }) => id === conversation?.[0]?.account);
  const reading = shown && conversation?.length && account ? { conversation, account } : undefined;
  const isShowing = reading !== undefined;
  const announce = useEffectEvent((id: ConversationId) => onShown?.(id));
  useEffect(() => {
    if (shown !== undefined && isShowing) announce(shown);
  }, [shown, isShowing]);
  usePreloadedReader(upcoming.length > 0);

  return (
    <section aria-label="Reader" {...stylex.props(styles.sheet)}>
      <header {...stylex.props(styles.phoneHeader)}>
        <IconButton
          label="Back"
          icon={<Icon icon={ChevronLeft} />}
          variant="ghost"
          onClick={onBack}
        />
      </header>
      {reading ? (
        <div {...stylex.props(styles.scroll)}>
          <Suspense>
            <Reader
              conversation={reading.conversation}
              account={reading.account}
              upcoming={shown === selected ? upcoming : []}
            />
          </Suspense>
        </div>
      ) : (
        <div {...stylex.props(styles.empty)}>
          <EmptyState
            icon={<Icon icon={MailOpen} size="lg" color="secondary" />}
            title="No conversation open"
            description="Choose one from the list to read it here."
          />
        </div>
      )}
    </section>
  );
}

/** How long a selection rests before the reader follows it, while the member moves quickly. */
const REST_MS = 150;

/**
 * The selection the reader shows. One made after a rest shows at once. While the member moves
 * quickly, as when holding a key, the reader waits until the selection rests, so it does no work
 * nobody would see, and the list keeps up.
 */
function useRestingSelection(selected: ConversationId | undefined): ConversationId | undefined {
  const [shown, setShown] = useState(selected);
  const changedAt = useRef(-Infinity);
  useLayoutEffect(() => {
    const now = performance.now();
    const hasRested = now - changedAt.current >= REST_MS;
    changedAt.current = now;
    if (hasRested) {
      setShown(selected);
      return;
    }
    const timer = setTimeout(() => setShown(selected), REST_MS);
    return () => clearTimeout(timer);
  }, [selected]);
  return shown;
}

/** How long after the list first shows something to open the reader starts loading. */
const PRELOAD_AFTER_MS = 1_000;

function usePreloadedReader(isWanted: boolean) {
  useEffect(() => {
    if (!isWanted) return;
    const timer = setTimeout(() => {
      // Safari has no idle callback.
      if ('requestIdleCallback' in window) requestIdleCallback(() => void loadReader());
      else void loadReader();
    }, PRELOAD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [isWanted]);
}

const styles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: {
      default: colorVars['--color-background-surface'],
      [media.phone]: 'transparent',
    },
    borderRadius: { default: tm.paneRadius, [media.phone]: 0 },
    boxShadow: { default: tm.sheetEdge, [media.phone]: 'none' },
    outline: {
      default: null,
      [media.forcedColors]: {
        default: `${borderVars['--border-width']} solid CanvasText`,
        [media.phone]: 'none',
      },
    },
  },
  phoneHeader: {
    display: { default: 'none', [media.phone]: 'flex' },
    paddingTop: tm.safeTop,
    paddingInline: spacingVars['--spacing-2'],
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    paddingTop: { default: spacingVars['--spacing-6'], [media.phone]: spacingVars['--spacing-1'] },
  },
  empty: {
    flexGrow: 1,
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
  },
});
