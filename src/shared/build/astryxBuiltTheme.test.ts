import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSync } from 'vite';
import { leanBuiltTheme, trapResolvedTokens } from './astryxBuiltTheme.ts';
import { splitUseTheme } from './astryxUseTheme.ts';

const BUILT = readFileSync(new URL('../../app/theme/built/trail-mix.js', import.meta.url), 'utf8');

/** The fields of the theme object a module exports, by name. */
const fieldsOf = (code: string) => {
  const { program } = parseSync('theme.js', code);
  const themes = program.body.flatMap((node) =>
    node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration'
      ? node.declaration.declarations.flatMap(({ init }) =>
          init?.type === 'ObjectExpression' ? init.properties : [],
        )
      : [],
  );
  return themes.map((field) =>
    field.type === 'Property' && field.key.type === 'Identifier'
      ? `${field.kind === 'get' ? 'get ' : ''}${field.key.name}`
      : '?',
  );
};

/** A module's exports once it runs, each name it imports standing for an empty object. */
const run = async (code: string): Promise<Record<string, unknown>> => {
  const folder = mkdtempSync(join(tmpdir(), 'built-theme-'));
  const module = join(folder, 'theme.mjs');
  writeFileSync(module, code.replace(/^import \{ (\w+) \} from .*$/gm, 'const $1 = {};'));
  try {
    return (await import(module)) as Record<string, unknown>;
  } finally {
    rmSync(folder, { recursive: true });
  }
};

test('the built theme keeps what Astryx reads at runtime, with its tokens empty', async () => {
  expect(fieldsOf(leanBuiltTheme(BUILT, false))).toEqual([
    'name',
    '__built',
    'tokens',
    'localTokens',
    '__adaptations',
    '__axes',
    'icons',
  ]);
  const theme = (await run(leanBuiltTheme(BUILT, false))).trailMixTheme as Record<string, unknown>;
  expect(theme.tokens).toEqual({});
  expect(theme.__axes).toMatchObject({ motion: { fast: 125, medium: 300 } });
});

test('a trapped build throws where Astryx reads a field the build leaves out', async () => {
  const theme = (await run(leanBuiltTheme(BUILT, true))).trailMixTheme as Record<string, unknown>;
  expect(theme.name).toBe('trail-mix');
  expect(() => theme.tokens).toThrow("Astryx read the built theme's tokens");
  expect(() => theme.components).toThrow("Astryx read the built theme's components");
  expect(() => ({ ...theme })).toThrow();
});

test('a built theme that no longer has a field the build leaves out fails the build', () => {
  const without = BUILT.replace(/^ {2}__onLight: \{[\s\S]*?^ {2}\},\n/m, '');
  expect(without).not.toContain('__onLight');
  expect(() => leanBuiltTheme(without, false)).toThrow('no longer has __onLight');
});

test("a trapped useTheme's resolved tokens throw when read", async () => {
  const { hook } = splitUseTheme(
    readFileSync(
      new URL('../../../node_modules/@astryxdesign/core/dist/theme/useTheme.js', import.meta.url),
      'utf8',
    ),
  );
  const trapped = trapResolvedTokens(hook);
  expect(trapped).not.toContain('resolveThemeTokens(');
  const { unresolvedTokens } = (await run(
    `${trapped.slice(trapped.indexOf('function unresolvedTokens'))}export { unresolvedTokens };\n`,
  )) as { unresolvedTokens: () => Record<string | symbol, unknown> };
  const tokens = unresolvedTokens();
  expect(tokens[Symbol.iterator]).toBeUndefined();
  expect(() => tokens['--color-accent']).toThrow("Astryx read the theme's --color-accent");
  expect(() => trapResolvedTokens(trapped)).toThrow('no longer calls resolveThemeTokens');
});
