import { registerTheme, ThemeContext } from '@astryxdesign/core/theme';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { colorVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useMemo, type ReactNode } from 'react';

/**
 * The app's root theme provider, for a theme prebuilt by `astryx theme build`. Its mode is the
 * system's, which Trail Mix follows with no choice of its own, so the shell's `color-scheme` and its
 * `theme-color` metas already show it before anything runs.
 *
 * It does what Astryx's `Theme` does for a built theme, without importing the generator that only
 * unbuilt themes use (color science, scale expansion, CSS emission), which the first load would
 * otherwise download and never run. Nested themes still use Astryx's own.
 */
export function AppTheme({ theme, children }: { theme: DefinedTheme; children: ReactNode }) {
  registerTheme(theme);

  // `<html>` carries the theme's name, so its scoped rules reach portals outside this subtree. The
  // shell named it already.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-astryx-theme', theme.name);
  }, [theme.name]);

  const value = useMemo(() => ({ theme, mode: 'system' as const }), [theme]);
  return (
    <ThemeContext value={value}>
      <div {...stylex.props(styles.root)} data-astryx-theme={theme.name}>
        {children}
      </div>
    </ThemeContext>
  );
}

const styles = stylex.create({
  root: {
    display: 'contents',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
  },
});
