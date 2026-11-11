import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { colorVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { CloudOff } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FirstRun, preloadFirstRun } from '../features/accounts/index.ts';
import type { Command } from '../features/commands/index.ts';
import { useConversations } from '../features/conversations/index.ts';
import { standing, useChangedFolders, viewCounts } from '../features/folders/index.ts';
import {
  addressOf,
  paramsOf,
  placeAt,
  placeOf,
  type Place,
  type PlaceParams,
  type View,
} from '../features/mail/core/index.ts';
import {
  accountsQuery,
  conversationQuery,
  conversationsQuery,
  foldersQuery,
  outboxQuery,
  useHints,
  whatFailed,
} from '../features/mailroom/client/index.ts';
import { REST_MS } from '../features/reader/index.ts';
import { Workbench } from '../features/workbench/index.ts';
import { AppTheme } from './theme/AppTheme.tsx';
import { tm } from './theme/tokens.stylex.ts';
import { trailMixTheme } from './theme/built/trail-mix.js';
import { AccentChoice } from './theme/AccentChoice.tsx';
import { ThemeChoice } from './theme/ThemeChoice.tsx';
import { accentCommands, themeCommands } from './theme/commands.ts';
import { useAccent } from './theme/useAccent.ts';
import { useThemeMode } from './theme/useThemeMode.ts';

export const Route = createFileRoute('/')({
  // The address names the member's place, which a reload, a link or a notification opens.
  validateSearch: (search): PlaceParams => paramsOf(placeOf(search)),
  // The loader asks for what the place shows as soon as the route is known, without waiting for
  // it, so the answers arrive while the app's code still runs and the first render has rows. It
  // runs again only for a place it hasn't asked for.
  loaderDeps: ({ search }) => search,
  staleTime: Infinity,
  loader: ({ context: { queryClient }, deps }) => {
    const { view, open } = placeOf(deps);
    void queryClient.prefetchQuery(accountsQuery);
    void queryClient.prefetchQuery(foldersQuery);
    void queryClient.prefetchQuery(outboxQuery);
    if (view.in !== 'outbox') void queryClient.prefetchQuery(conversationsQuery(view));
    if (open !== undefined) void queryClient.prefetchQuery(conversationQuery(open));
  },
  component: App,
});

/**
 * The member's mail, or, for a member with no accounts, the first-run screen, where they add one.
 * Until the Mailroom says which, the desk stays bare, so neither screen shows only to give way to
 * the other. The first-run screen shows once its code has loaded too.
 */
function App() {
  const [mode, setMode] = useThemeMode();
  const [accent, setAccent] = useAccent();
  // The hint socket is open on the first-run screen too, so an account added on another device
  // shows here.
  useHints();
  const accounts = useQuery(accountsQuery);
  const { refetch } = accounts;
  const askAgain = useCallback(() => void refetch(), [refetch]);
  const isFirstRun = accounts.data?.length === 0;
  const welcome = useLoaded(preloadFirstRun, isFirstRun);
  const screen =
    accounts.data === undefined ? (
      accounts.isError && <Unreachable failed={accounts.error} onTryAgain={askAgain} />
    ) : !isFirstRun ? (
      <Desk
        sidebarFooter={
          <>
            <AccentChoice accent={accent} onChange={setAccent} />
            <ThemeChoice mode={mode} onChange={setMode} />
          </>
        }
        extraCommands={[...themeCommands(mode, setMode), ...accentCommands(accent, setAccent)]}
      />
    ) : welcome === 'failed' ? (
      <Unreachable />
    ) : (
      welcome === 'loaded' && <FirstRun />
    );
  return (
    <AppTheme theme={trailMixTheme} mode={mode}>
      {screen}
    </AppTheme>
  );
}

/** Whether code `load` brings in has arrived, once it is wanted. */
function useLoaded(load: () => Promise<unknown>, isWanted: boolean) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  useEffect(() => {
    if (!isWanted) return;
    let isCurrent = true;
    load().then(
      () => isCurrent && setState('loaded'),
      () => isCurrent && setState('failed'),
    );
    return () => {
      isCurrent = false;
    };
  }, [load, isWanted]);
  return state;
}

/**
 * The Mailroom couldn't be asked, as when the network is down or the sign-in has run out, and what
 * failed. It asks again by itself when the page is seen again or the network comes back, as after
 * a deploy that cut it off for a moment. Try again loads the page anew, which signs in again where
 * the sign-in has run out.
 */
function Unreachable({ failed, onTryAgain }: { failed?: unknown; onTryAgain?: () => void }) {
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
  return (
    <main {...stylex.props(styles.desk)}>
      <EmptyState
        headingLevel={1}
        icon={<Icon icon={CloudOff} size="lg" color="secondary" />}
        title="Trail Mix can’t reach your mail"
        description="The connection or your sign-in may have lapsed."
        actions={
          <div {...stylex.props(styles.actions)}>
            <Button label="Try again" variant="primary" onClick={() => location.reload()} />
            {failed !== undefined && <p {...stylex.props(styles.failed)}>{whatFailed(failed)}</p>}
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

const NONE = [] as const;

/** The member's mail on the workbench, which the hint socket keeps current. */
function Desk({
  sidebarFooter,
  extraCommands,
}: {
  sidebarFooter: ReactNode;
  extraCommands: readonly Command[];
}) {
  const { place, changePlace, goBack } = usePlace();
  const { view } = place;
  const accounts = useQuery(accountsQuery).data ?? NONE;
  // Folder changes on their way show at once, laid over the Mailroom's snapshot.
  const held = useQuery(foldersQuery).data;
  const folders = useChangedFolders(held ?? NONE);
  // An address whose folder has gone opens the Inbox instead, and says so. It's checked as the
  // view arrives, from the address or once the folders are first known, not as the folders change,
  // since a folder renamed in view is laid over them a moment before the view follows it.
  const isHeld = held !== undefined;
  const foldersNow = useRef(folders);
  useLayoutEffect(() => {
    foldersNow.current = folders;
  });
  useEffect(() => {
    if (!isHeld) return;
    const kept = standing(view, foldersNow.current);
    if (kept !== view) changePlace({ view: kept }, 'replace');
  }, [view, isHeld, changePlace]);
  const outbox = useQuery(outboxQuery).data ?? NONE;
  const counts = useMemo(() => viewCounts(folders, outbox), [folders, outbox]);
  // The Outbox lists sends, not conversations.
  const { conversations, isFetching, show } = useConversations(view, {
    enabled: view.in !== 'outbox',
  });

  return (
    <Workbench
      place={place}
      onPlaceChange={changePlace}
      onBack={goBack}
      accounts={accounts}
      folders={folders}
      counts={counts}
      conversations={conversations}
      isFetching={isFetching}
      onListShown={show}
      sidebarFooter={sidebarFooter}
      extraCommands={extraCommands}
    />
  );
}

/**
 * The member's place, and how to move it: pushed onto the address, so Back returns, or replacing
 * it, as a search typed or a key's move does. The place changes at once, so the search field shows
 * each key as it lands, and the address follows: a push at once, and a replace once the place has
 * rested, so typing and moving by key don't write the address at every step. The place follows the
 * address when the member moves through its history, keeping its view while only the open
 * conversation changes, so what shows the view alone doesn't render again.
 */
function usePlace() {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const [place, setPlace] = useState(() => placeAt(router.history.location.href));
  const resting = useRef<{ place: Place; timer: ReturnType<typeof setTimeout> }>(undefined);
  const write = useCallback(
    (place: Place, history: 'push' | 'replace') =>
      void navigate({ search: paramsOf(place), replace: history === 'replace' }),
    [navigate],
  );
  // Writes a resting place now. The browser takes the address a moment after it's written, and a
  // push in the same moment would take its place, so it's handed to the browser at once.
  const settle = useCallback(() => {
    if (!resting.current) return;
    clearTimeout(resting.current.timer);
    write(resting.current.place, 'replace');
    resting.current = undefined;
    router.history.flush();
  }, [write, router]);

  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        if (action.type === 'PUSH' || action.type === 'REPLACE') return;
        // A place still resting belonged to the entry the member has left.
        clearTimeout(resting.current?.timer);
        resting.current = undefined;
        const { view, open } = placeAt(location.href);
        setPlace((current) => {
          const kept = isSameView(view, current.view) ? current.view : view;
          return open === undefined ? { view: kept } : { view: kept, open };
        });
      }),
    [router],
  );
  useEffect(() => () => clearTimeout(resting.current?.timer), []);

  const changePlace = useCallback(
    (next: Place, history: 'push' | 'replace') => {
      setPlace(next);
      if (history === 'push') {
        settle();
        write(next, 'push');
        return;
      }
      clearTimeout(resting.current?.timer);
      const timer = setTimeout(() => {
        resting.current = undefined;
        write(next, 'replace');
      }, REST_MS);
      resting.current = { place: next, timer };
    },
    [settle, write],
  );
  const goBack = useCallback(() => {
    settle();
    router.history.back();
  }, [settle, router]);
  return { place, changePlace, goBack };
}

const isSameView = (one: View, other: View) =>
  addressOf({ view: one }) === addressOf({ view: other });
