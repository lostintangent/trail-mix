import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { astryxUseTheme, HOOK, hookImportsOf, splitUseTheme } from './astryxUseTheme.ts';

const read = (path: string) =>
  readFileSync(
    new URL(`../../../node_modules/@astryxdesign/core/dist/${path}`, import.meta.url),
    'utf8',
  );
const scan = (code: string) => new Bun.Transpiler({ loader: 'js' }).scan(code);
const USE_THEME = read('theme/useTheme.js');

test('what stays of useTheme.js no longer imports the theme generator, and still serves Icon', () => {
  const { rest } = splitUseTheme(USE_THEME);
  const { imports, exports } = scan(rest);
  expect(imports.map(({ path }) => path)).not.toContain('./tokens.js');
  expect(exports).toContain('useThemeName');
  expect(exports).toContain('ThemeContext');
  expect(exports).not.toContain('useTheme');
});

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

test("Astryx's importers name the hook from its own module, and keep their other names", () => {
  expect(hookImportsOf(read('hooks/useAutoMediaMode.js'))).toContain(
    `import { useTheme } from "../theme/useTheme.js${HOOK}";`,
  );
  const barrel = hookImportsOf(read('theme/index.js'));
  expect(barrel).toContain('export { useThemeName, ThemeContext } from "./useTheme.js";');
  expect(barrel).toContain(`export { useTheme } from "./useTheme.js${HOOK}";`);
  expect(hookImportsOf(read('Icon/Icon.js'))).toBeNull();
  expect(hookImportsOf('import { useTheme as theme, useThemeName } from "./useTheme.js";')).toBe(
    `import { useThemeName } from "./useTheme.js";\nimport { useTheme as theme } from "./useTheme.js${HOOK}";`,
  );
});

test('the build fails when the chunk holding useTheme.js loads the generator, and not when only a lazy one does', () => {
  const chunk = (
    fileName: string,
    modules: string[],
    imports: string[] = [],
    dynamic: string[] = [],
  ) => ({
    type: 'chunk',
    fileName,
    imports,
    dynamicImports: dynamic,
    modules: Object.fromEntries(modules.map((id) => [id, { renderedLength: 1 }])),
  });
  const astryx = (path: string) => `/app/node_modules/@astryxdesign/core/dist/theme/${path}`;
  const failures = (bundle: Record<string, unknown>) => {
    const errors: string[] = [];
    const generateBundle = astryxUseTheme().generateBundle as (
      this: { error: (message: string) => void },
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void;
    generateBundle.call({ error: (message: string) => errors.push(message) }, {}, bundle);
    return errors;
  };

  const shared = {
    'first.js': chunk('first.js', [astryx('useTheme.js')], [], ['toast.js']),
    'toast.js': chunk('toast.js', [astryx('generateThemeRules.js')], ['first.js']),
  };
  expect(failures(shared)).toEqual([]);

  const loaded = {
    'first.js': chunk('first.js', [astryx('useTheme.js')], ['theme.js']),
    'theme.js': chunk('theme.js', [astryx('generateThemeRules.js')]),
  };
  expect(failures(loaded)).toEqual([
    "Astryx's theme generator is in theme.js, which loads with useTheme.js, so it is back on the first load.",
  ]);
});
