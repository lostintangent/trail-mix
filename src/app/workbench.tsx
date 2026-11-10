import { createFileRoute } from '@tanstack/react-router';
import { Workbench } from '../features/workbench/index.ts';
import { AppTheme } from './theme/AppTheme.tsx';
import { trailMixTheme } from './theme/built/trail-mix.js';
import { ThemeChoice } from './theme/ThemeChoice.tsx';
import { useThemeMode } from './theme/useThemeMode.ts';

export const Route = createFileRoute('/')({ component: App });

function App() {
  const [mode, setMode] = useThemeMode();
  return (
    <AppTheme theme={trailMixTheme} mode={mode}>
      <Workbench sidebarFooter={<ThemeChoice mode={mode} onChange={setMode} />} />
    </AppTheme>
  );
}
