import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CloudOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FirstRun, preloadFirstRun } from '../features/accounts/index.ts';
import type { Command } from '../features/commands/index.ts';
import { useTriagedList } from '../features/conversations/index.ts';
import { useChangedFolders, viewCounts } from '../features/folders/index.ts';
import type { View } from '../features/mail/core/index.ts';
import {
  accountsQuery,
  conversationsQuery,
  foldersQuery,
  outboxQuery,
  useHints,
} from '../features/mailroom/client/index.ts';
import { Workbench } from '../features/workbench/index.ts';
import { AppTheme } from './theme/AppTheme.tsx';
import { trailMixTheme } from './theme/built/trail-mix.js';
import { AccentChoice } from './theme/AccentChoice.tsx';
import { ThemeChoice } from './theme/ThemeChoice.tsx';
import { accentCommands, themeCommands } from './theme/commands.ts';
import { useAccent } from './theme/useAccent.ts';
import { useThemeMode } from './theme/useThemeMode.ts';

/** Where the workbench opens. */
const FIRST_VIEW: View = { in: 'inbox' };

export const Route = createFileRoute('/')({
  // The loader asks for what the first screen shows as soon as the route is known, without waiting
  // for it, so the answers arrive while the app's code still runs and the first render has rows.
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(accountsQuery);
    void queryClient.prefetchQuery(foldersQuery);
    void queryClient.prefetchQuery(outboxQuery);
    void queryClient.prefetchInfiniteQuery(conversationsQuery(FIRST_VIEW));
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
  const isFirstRun = accounts.data?.length === 0;
  const welcome = useLoaded(preloadFirstRun, isFirstRun);
  const screen =
    accounts.data === undefined ? (
      accounts.isError && <Unreachable />
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
 * The Mailroom couldn't be asked, as when the network is down or the sign-in has run out. Loading
 * the page again signs in anew where it has.
 */
function Unreachable() {
  return (
    <main {...stylex.props(styles.desk)}>
      <EmptyState
        headingLevel={1}
        icon={<Icon icon={CloudOff} size="lg" color="secondary" />}
        title="Trail Mix can’t reach your mail"
        description="The connection or your sign-in may have lapsed."
        actions={<Button label="Try again" variant="primary" onClick={() => location.reload()} />}
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
  const [view, setView] = useState(FIRST_VIEW);
  const accounts = useQuery(accountsQuery).data ?? NONE;
  // Folder changes on their way show at once, laid over the Mailroom's snapshot.
  const folders = useChangedFolders(useQuery(foldersQuery).data ?? NONE);
  const outbox = useQuery(outboxQuery).data ?? NONE;
  const counts = useMemo(() => viewCounts(folders, outbox), [folders, outbox]);
  const { data, hasNextPage, isFetching, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...conversationsQuery(view),
    // The Outbox lists sends, not conversations.
    enabled: view.in !== 'outbox',
    // While a search is typed, the results so far stay until the next arrive, so the list doesn't
    // blink between keystrokes.
    placeholderData: (previous, previousQuery) =>
      view.in === 'search' && previousQuery?.queryKey[1].in === 'search' ? previous : undefined,
  });
  const listed = useMemo(() => data?.pages.flatMap(({ items }) => items), [data]);
  const conversations = useTriagedList(view, listed);
  const onListNearEnd = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <Workbench
      view={view}
      onViewChange={setView}
      accounts={accounts}
      folders={folders}
      counts={counts}
      conversations={conversations}
      hasMore={hasNextPage}
      isFetching={isFetching}
      onListNearEnd={onListNearEnd}
      sidebarFooter={sidebarFooter}
      extraCommands={extraCommands}
    />
  );
}
