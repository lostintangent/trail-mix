import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { View } from '../features/mail/core/index.ts';
import { Workbench } from '../features/workbench/index.ts';
import { AppTheme } from './theme/AppTheme.tsx';
import { trailMixTheme } from './theme/built/trail-mix.js';
import { ThemeChoice } from './theme/ThemeChoice.tsx';
import { useThemeMode } from './theme/useThemeMode.ts';

export const Route = createFileRoute('/')({ component: App });

// Until the Mailroom serves them.
const NONE = [] as const;
const NO_COUNTS = {};

function App() {
  const [mode, setMode] = useThemeMode();
  const [view, setView] = useState<View>({ in: 'inbox' });
  return (
    <AppTheme theme={trailMixTheme} mode={mode}>
      <Workbench
        view={view}
        onViewChange={setView}
        accounts={NONE}
        folders={NONE}
        counts={NO_COUNTS}
        conversations={NONE}
        sidebarFooter={<ThemeChoice mode={mode} onChange={setMode} />}
      />
    </AppTheme>
  );
}
