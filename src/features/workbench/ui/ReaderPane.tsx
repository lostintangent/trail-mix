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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, ConversationId, Message } from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';
import { preloadTriageActions } from '../../conversations/index.ts';
import { PhoneIsland } from './PhoneIsland.tsx';

/** The conversation the reader shows, with its messages and the account they belong to. */
export type Reading = { id: ConversationId; conversation: Message[]; account: Account };

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
  actions,
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
  /**
   * What can be done to the conversation shown: in a bar above it on a desktop, and on a phone in
   * the island at the bottom of the screen, which has room for fewer.
   */
  actions?: (reading: Reading, place: 'bar' | 'island') => ReactNode;
  onBack: () => void;
}) {
  const shown = useRestingSelection(selected);
  const { data: conversation } = useQuery({
    ...conversationQuery(shown ?? ''),
    enabled: shown !== undefined,
  });
  const account = accounts.find(({ id }) => id === conversation?.[0]?.account);
  const reading = useMemo<Reading | undefined>(
    () =>
      shown && conversation?.length && account ? { id: shown, conversation, account } : undefined,
    [shown, conversation, account],
  );
  // Made once for each conversation shown, so the moves of a held key pass them by.
  const bar = useMemo(() => reading && actions?.(reading, 'bar'), [reading, actions]);
  const island = useMemo(() => reading && actions?.(reading, 'island'), [reading, actions]);
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
      {bar ? (
        <div role="toolbar" aria-label="Conversation" {...stylex.props(styles.bar)}>
          <Suspense>{bar}</Suspense>
        </div>
      ) : null}
      {reading ? (
        <div {...stylex.props(styles.scroll, actions && styles.underBar)}>
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
      {island ? (
        <PhoneIsland label="Conversation">
          <Suspense>{island}</Suspense>
        </PhoneIsland>
      ) : null}
    </section>
  );
}

/** How long a selection rests before the reader follows it, while the member moves quickly. */
const REST_MS = 150;

/**
 * The selection the reader shows. One made after a rest shows at once. While the member moves
 * quickly, as when holding a key, the reader waits until the selection rests, so it does no work
 * nobody would see, and the list keeps up.
 *
 * A move is timed by the press that made it, not by when it was drawn, so on a slow phone a render
 * that runs long can't make quick presses look like rests.
 */
function useRestingSelection(selected: ConversationId | undefined): ConversationId | undefined {
  const [shown, setShown] = useState(selected);
  const pressedAt = useLastPress();
  const movedAt = useRef(-Infinity);
  useLayoutEffect(() => {
    const now = performance.now();
    const at = pressedAt.current > movedAt.current ? pressedAt.current : now;
    const hasRested = at - movedAt.current >= REST_MS;
    movedAt.current = at;
    if (hasRested) {
      setShown(selected);
      return;
    }
    const timer = setTimeout(() => setShown(selected), REST_MS);
    return () => clearTimeout(timer);
  }, [selected, pressedAt]);
  return shown;
}

/** When the member last pressed a key or a pointer, as the event says, however late it ran. */
function useLastPress() {
  const pressedAt = useRef(-Infinity);
  useEffect(() => {
    const note = (event: Event) => {
      pressedAt.current = event.timeStamp;
    };
    window.addEventListener('keydown', note, { capture: true });
    window.addEventListener('pointerdown', note, { capture: true });
    return () => {
      window.removeEventListener('keydown', note, { capture: true });
      window.removeEventListener('pointerdown', note, { capture: true });
    };
  }, []);
  return pressedAt;
}

/** How long after the list first shows something to open the reader starts loading. */
const PRELOAD_AFTER_MS = 1_000;

function usePreloadedReader(isWanted: boolean) {
  useEffect(() => {
    if (!isWanted) return;
    const timer = setTimeout(() => {
      // Safari has no idle callback.
      const load = () => {
        void loadReader();
        preloadTriageActions();
      };
      if ('requestIdleCallback' in window) requestIdleCallback(load);
      else load();
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
  // On a desktop the conversation's actions sit in a bar along the top of its sheet.
  bar: {
    display: { default: 'flex', [media.phone]: 'none' },
    flexShrink: 0,
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
    paddingTop: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-2'],
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    paddingTop: { default: spacingVars['--spacing-6'], [media.phone]: spacingVars['--spacing-1'] },
  },
  // Below a desktop's bar the subject needs less room above it, and on a phone the conversation
  // ends above the island: its height, its padding, and the gap below it.
  underBar: {
    paddingTop: { default: spacingVars['--spacing-2'], [media.phone]: spacingVars['--spacing-1'] },
    paddingBottom: {
      default: null,
      [media.phone]: `calc(${tm.target} + ${spacingVars['--spacing-1']} * 2 + ${spacingVars['--spacing-3']} + ${tm.safeBottom})`,
    },
  },
  empty: {
    flexGrow: 1,
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
  },
});
