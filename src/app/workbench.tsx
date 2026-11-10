import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { viewCounts } from '../features/folders/index.ts';
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
import { ThemeChoice } from './theme/ThemeChoice.tsx';
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

function App() {
  const [mode, setMode] = useThemeMode();
  return (
    <AppTheme theme={trailMixTheme} mode={mode}>
      <Desk sidebarFooter={<ThemeChoice mode={mode} onChange={setMode} />} />
    </AppTheme>
  );
}

const NONE = [] as const;

/** The member's mail on the workbench, kept current by the hint socket. */
function Desk({ sidebarFooter }: { sidebarFooter: ReactNode }) {
  useHints();
  const [view, setView] = useState(FIRST_VIEW);
  const accounts = useQuery(accountsQuery).data ?? NONE;
  const folders = useQuery(foldersQuery).data ?? NONE;
  const outbox = useQuery(outboxQuery).data ?? NONE;
  const counts = useMemo(() => viewCounts(folders, outbox), [folders, outbox]);
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    conversationsQuery(view),
  );
  const conversations = useMemo(() => data?.pages.flatMap(({ items }) => items), [data]);
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
      onListNearEnd={onListNearEnd}
      sidebarFooter={sidebarFooter}
    />
  );
}
