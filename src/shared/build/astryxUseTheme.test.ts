import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitUseTheme } from './astryxUseTheme.ts';

const read = (path: string) =>
  readFileSync(
    new URL(`../../../node_modules/@astryxdesign/core/dist/${path}`, import.meta.url),
    'utf8',
  );
const scan = (code: string) => new Bun.Transpiler({ loader: 'js' }).scan(code);
const USE_THEME = read('theme/useTheme.js');

test('the hook moves with everything it calls, and resolves the theme as it did', async () => {
  const { hook } = splitUseTheme(USE_THEME);
  expect(scan(hook).exports).toEqual(['useTheme']);
  expect(scan(hook).imports.map(({ path }) => path)).toContain('./tokens.js');

  // Its imports become stand-ins, so a name it calls but no longer has throws as it runs.
  const folder = mkdtempSync(join(tmpdir(), 'use-theme-'));
  const standIns = {
    use: () => ({ theme: { name: 'trail-mix' }, mode: 'system' }),
    useRootModeAttr: () => null,
    useRootThemeNameAttr: () => null,
    useMediaQuery: () => true,
    getRegisteredTheme: () => undefined,
    resolveThemeTokens: (_: unknown, { mode }: { mode: string }) => ({ '--color-ink': mode }),
    useMemo: (make: () => unknown) => make(),
    useCallback: (callback: unknown) => callback,
  };
  (globalThis as unknown as { standIns: typeof standIns }).standIns = standIns;
  const bound = Array.from(hook.matchAll(/^import \{([^}]*)\}/gm), ([, names = '']) =>
    names.split(',').map((name) =>
      name
        .trim()
        .split(/\s+as\s+/)
        .at(-1)!,
    ),
  ).flat();
  const module = join(folder, 'hook.mjs');
  writeFileSync(
    module,
    `const { ${bound.join(', ')} } = globalThis.standIns;\n${hook.replace(/^import [^;]+;\n/gm, '')}`,
  );
  const { useTheme } = (await import(module)) as {
    useTheme: () => { name: string; mode: string; token: (name: string) => string };
  };
  rmSync(folder, { recursive: true });
  const resolved = useTheme();
  expect(resolved.name).toBe('trail-mix');
  expect(resolved.mode).toBe('dark');
  expect(resolved.token('--color-ink')).toBe('dark');
});

test('a useTheme.js the split no longer fits stops the build, rather than keeping the generator', () => {
  // Icon's hook reading tokens would keep tokens.js, and the generator, in what stays.
  const tokensInIcon = USE_THEME.replace(
    'export function useThemeName() {',
    'export function useThemeName() {\n  resolveThemeTokens;',
  );
  expect(tokensInIcon).not.toBe(USE_THEME);
  expect(() => splitUseTheme(tokensInIcon)).toThrow(/still imports tokens\.js/);

  const renamed = USE_THEME.replace(
    'export function useTheme() {',
    'export function useTokens() {',
  );
  expect(() => splitUseTheme(renamed)).toThrow(/no longer has one/);

  expect(() => splitUseTheme(`${USE_THEME}\nexport const after = 1;\n`)).toThrow(/after useTheme/);
});
