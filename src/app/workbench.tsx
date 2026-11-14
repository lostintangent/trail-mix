import { colorVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import {
  Suspense,
  useCallback,
  useDeferredValue,
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
  bundleQuery,
  conversationQuery,
  conversationsQuery,
  foldersQuery,
  outboxQuery,
  useHints,
} from '../features/mailroom/client/index.ts';
import {
  notificationCommands,
  useNotificationOpenings,
  useNotifications,
} from '../features/notifications/index.ts';
import { useDraftsAway, useLeaving } from '../features/outbox/index.ts';
import { REST_MS } from '../features/reader/index.ts';
import { afterFirstScreen } from '../shared/afterFirstScreen.ts';
import { useHeldWhile } from '../shared/useHeldWhile.ts';
import { Workbench, type SettingsAt } from '../features/workbench/index.ts';
import { preloadable } from '../shared/preloadable.ts';
import { useHasMail } from './hasMail.ts';
import { AppTheme } from './theme/AppTheme.tsx';
import { tm } from './theme/tokens.stylex.ts';
import { trailMixTheme } from './theme/built/trail-mix.js';
import { accentCommands } from './theme/commands.ts';
import { useAccent } from './theme/useAccent.ts';

export const Route = createFileRoute('/')({
  // The address names the member's place, which a reload, a link or a notification opens.
  validateSearch: (search): PlaceParams => paramsOf(placeOf(search)),
  // The loader asks for what the place shows as soon as the route is known, without waiting for
  // it, so the answers arrive while the app's code still runs and the first render has rows. It
  // runs again only for a place it hasn't asked for.
  loaderDeps: ({ search }) => search,
  staleTime: Infinity,
  loader: ({ context: { queryClient }, deps }) => {
    const { view, bundle, open } = placeOf(deps);
    void queryClient.prefetchQuery(accountsQuery);
    void queryClient.prefetchQuery(foldersQuery);
    void queryClient.prefetchQuery(outboxQuery);
    // A list of unread mail holds the conversation open in it, read or not.
    const keep = 'unread' in view && view.unread ? (bundle ?? open) : undefined;
    if (view.in !== 'outbox') void queryClient.prefetchQuery(conversationsQuery(view, 0, keep));
    if (bundle !== undefined) void queryClient.prefetchQuery(bundleQuery(bundle));
    if (open !== undefined) void queryClient.prefetchQuery(conversationQuery(open));
  },
  component: App,
});

/**
 * The member's mail, or, for a member with no accounts, the first-run screen, where they add one.
 * A device that last saw mail draws the workbench at once, its skeletons standing in until the
 * Mailroom answers. Any other waits for the Mailroom to say which, on a quiet desk, so the
 * workbench never shows only to give way to the welcome. The first-run screen shows once its code
 * has loaded too.
 */
function App() {
  const [accent, setAccent] = useAccent();
  const notifications = useNotifications();
  // The hint socket is open on the first-run screen too, so an account added on another device
  // shows here.
  useHints();
  const accounts = useQuery(accountsQuery);
  const { refetch } = accounts;
  const askAgain = useCallback(() => void refetch(), [refetch]);
  const isUnreached = accounts.data === undefined && accounts.isError;
  // Saying so may wait for its code, as when the network went before the page was idle, so the
  // screen before stays until it has come, rather than a bare desk.
  const saysUnreached = useDeferredValue(isUnreached) && isUnreached;
  const isFirstRun = accounts.data?.length === 0;
  const welcome = useLoaded(preloadFirstRun, isFirstRun);
  const hasMail = useHasMail(accounts.data);
  usePreloadWhenIdle(preloadUnreachable);
  usePreloadWhenIdle(preloadSettings);
  const settings = useCallback(
    (at: SettingsAt | undefined) => (
      <Suspense>
        <Settings at={at} notifications={notifications} accent={accent} onAccent={setAccent} />
      </Suspense>
    ),
    [notifications, accent, setAccent],
  );
  const extraCommands = useCallback(
    (openSettings: (at?: SettingsAt) => void) => [
      ...notificationCommands(notifications),
      ...accentCommands(accent, setAccent, () => openSettings('accent')),
    ],
    [notifications, accent, setAccent],
  );
  const screen = saysUnreached ? (
    <Unreachable failed={accounts.error} onTryAgain={askAgain} />
  ) : accounts.data === undefined && !hasMail ? (
    <Opening />
  ) : !isFirstRun ? (
    <Desk settings={settings} extraCommands={extraCommands} />
  ) : welcome === 'failed' ? (
    <Unreachable />
  ) : (
    welcome === 'loaded' && <FirstRun />
  );
  return (
    <AppTheme theme={trailMixTheme}>
      <Suspense>{screen}</Suspense>
    </AppTheme>
  );
}

/**
 * What the app says when it can't reach the Mailroom, which the first screen goes without. It loads
 * once the first screen is idle, so it's in hand when the network goes, as long as the page loaded.
 */
const { Component: Unreachable, preload: preloadUnreachable } = preloadable(
  async () => (await import('./Unreachable.tsx')).Unreachable,
);

/** Settings, which the first screen goes without, and which loads once that screen is idle. */
const { Component: Settings, preload: preloadSettings } = preloadable(
  async () => (await import('./settings.tsx')).Settings,
);

/** Loads `load` once the first screen has had its turn and the browser is idle. */
function usePreloadWhenIdle(load: () => Promise<unknown>) {
  useEffect(() => afterFirstScreen(() => void load().catch(() => {})), [load]);
}

/** How long a device that doesn't know whether there's mail waits before saying it's opening. */
const OPENING_QUIET_MS = 300;

/**
 * The desk while the Mailroom is first asked whether there's mail: bare at first, so a quick answer
 * shows nothing at all, and after a moment a quiet word that it's on its way.
 */
function Opening() {
  const [isSlow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), OPENING_QUIET_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <main aria-busy {...stylex.props(styles.desk)}>
      {isSlow && (
        <p role="status" {...stylex.props(styles.opening)}>
          Opening your mail…
        </p>
      )}
    </main>
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

const styles = stylex.create({
  desk: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
    backgroundColor: colorVars['--color-background-body'],
  },
  opening: {
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
});

const NONE = [] as const;

/** The member's mail on the workbench, which the hint socket keeps current. */
function Desk({
  settings,
  extraCommands,
}: {
  settings: (at: SettingsAt | undefined) => ReactNode;
  extraCommands: (openSettings: (at?: SettingsAt) => void) => readonly Command[];
}) {
  const { place, changePlace, goBack } = usePlace();
  const { view } = place;
  // A tapped notification brought this Trail Mix forward, to open its conversation.
  useNotificationOpenings(
    useCallback((address: string) => changePlace(placeAt(address), 'push'), [changePlace]),
  );
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
  const { data: outbox = NONE, isRefetching: isOutboxComing } = useQuery(outboxQuery);
  // Mail on its way is in the Outbox, and out of Drafts and its count, from the press of Send
  // until its draft has gone from the server's Drafts.
  const leaving = useLeaving();
  const { onTheirWay, withoutAway } = useDraftsAway(leaving.all, folders);
  // While the Outbox's next snapshot is on its way, the counts wait for it, since the folders may
  // already have counted without a send the Outbox still holds. Its first snapshot holds nothing up.
  const counts = useHeldWhile(
    isOutboxComing,
    useMemo(() => viewCounts(folders, outbox, onTheirWay), [folders, outbox, onTheirWay]),
  );
  // The Outbox lists sends, not conversations.
  const {
    conversations: listed,
    isFetching,
    show,
  } = useConversations(view, {
    enabled: view.in !== 'outbox',
    keep: place.bundle ?? place.open,
  });
  const conversations = useMemo(() => withoutAway(listed, view), [withoutAway, listed, view]);

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
      settings={settings}
      extraCommands={extraCommands}
      leaving={leaving}
    />
  );
}

/**
 * The member's place, and how to move it: pushed onto the address, so Back returns, or replacing
 * it, as a search typed or a key's move does. The place changes at once, so the search field shows
 * each key as it lands, and the address follows: a push at once, and a replace once the place has
 * rested, so typing and moving by key don't write the address at every step. The place follows the
 * address when the member moves through its history, keeping its view while only the bundle or the
 * conversation open in it changes, so what shows the view alone doesn't render again.
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
        const { view, ...opened } = placeAt(location.href);
        setPlace((current) => ({
          view: isSameView(view, current.view) ? current.view : view,
          ...opened,
        }));
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
