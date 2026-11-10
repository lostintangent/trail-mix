import { registerTheme, ThemeContext } from '@astryxdesign/core/theme';
import type { DefinedTheme, ThemeMode } from '@astryxdesign/core/theme';
import { colorVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useMemo, type ReactNode } from 'react';
import { paintThemeColor } from './mode.ts';
import { DESK_HEX } from './palette.ts';

/**
 * The app's root theme provider, for a theme prebuilt by `astryx theme build`.
 *
 * It does what Astryx's `Theme` does for a built theme, without importing the generator that only
 * unbuilt themes use (color science, scale expansion, CSS emission), which the first load would
 * otherwise download and never run. Nested themes still use Astryx's own.
 */
export function AppTheme({
  theme,
  mode,
  children,
}: {
  theme: DefinedTheme;
  mode: ThemeMode;
  children: ReactNode;
}) {
  registerTheme(theme);

  // `<html>` carries the mode, which the theme's CSS maps to `color-scheme`, and the theme's name,
  // so its scoped rules reach portals outside this subtree. The browser's chrome takes the mode's
  // desk. The prepaint script did all three already.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    root.setAttribute('data-astryx-theme', theme.name);
    paintThemeColor(mode, DESK_HEX);
  }, [mode, theme.name]);

  const value = useMemo(() => ({ theme, mode }), [theme, mode]);
  return (
    <ThemeContext value={value}>
      <div
        {...stylex.props(styles.root)}
        data-astryx-theme={theme.name}
        data-theme={mode === 'system' ? undefined : mode}
      >
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
