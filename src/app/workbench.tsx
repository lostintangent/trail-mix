import { createFileRoute } from '@tanstack/react-router';
import { Workbench } from '../features/workbench/index.ts';
import { AppTheme } from './theme/AppTheme.tsx';
import { trailMixTheme } from './theme/built/trail-mix.js';
import { ThemeChoice } from './theme/ThemeChoice.tsx';
import { useThemeMode } from './theme/useThemeMode.ts';

export const Route = createFileRoute('/')({ component: App });

// Until the Mailroom serves them.
const NONE = [] as const;
const NO_STAMPS = new Map<string, never>();

function App() {
  const [mode, setMode] = useThemeMode();
  return (
    <AppTheme theme={trailMixTheme} mode={mode}>
      <Workbench
        conversations={NONE}
        stamps={NO_STAMPS}
        sidebarFooter={<ThemeChoice mode={mode} onChange={setMode} />}
      />
    </AppTheme>
  );
}
