import { QueryClientProvider, useInfiniteQuery, useQuery } from '@tanstack/react-query';
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
import { createQueryClient } from '../shared/query-client.ts';
import { AppTheme } from './theme/AppTheme.tsx';
import { trailMixTheme } from './theme/built/trail-mix.js';
import { ThemeChoice } from './theme/ThemeChoice.tsx';
import { useThemeMode } from './theme/useThemeMode.ts';

export const Route = createFileRoute('/')({ component: App });

const queryClient = createQueryClient();

function App() {
  const [mode, setMode] = useThemeMode();
  return (
    <AppTheme theme={trailMixTheme} mode={mode}>
      <QueryClientProvider client={queryClient}>
        <Desk sidebarFooter={<ThemeChoice mode={mode} onChange={setMode} />} />
      </QueryClientProvider>
    </AppTheme>
  );
}

const NONE = [] as const;

/** The member's mail on the workbench, kept current by the hint socket. */
function Desk({ sidebarFooter }: { sidebarFooter: ReactNode }) {
  useHints();
  const [view, setView] = useState<View>({ in: 'inbox' });
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
