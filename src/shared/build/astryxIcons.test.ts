import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  neutralIconsOnly,
  prunedButAsked,
  quotedNames,
  registeredIcons,
  THEME_ICON_NAMES,
} from './astryxIcons.ts';

const read = (path: string) =>
  readFileSync(new URL(`../../../node_modules/${path}`, import.meta.url), 'utf8');

test('field statuses ask for their icons through lookup tables, and the kept list covers them', () => {
  const registered = registeredIcons(read('@astryxdesign/theme-neutral/dist/icons.mjs'));
  expect(registered.size).toBeGreaterThan(THEME_ICON_NAMES.size);
  const asked = new Set([
    ...quotedNames(read('@astryxdesign/core/dist/FieldStatus/FieldStatus.js')),
    ...quotedNames(read('@astryxdesign/core/dist/hooks/useInputStatusIcon.js')),
  ]);
  // 4163927 kept only these, which blanked every field error, warning, and success icon.
  const before = new Set(['check', 'chevronDown', 'chevronLeft', 'chevronRight', 'close', 'info']);
  expect(prunedButAsked(asked, registered, before)).toEqual(['error', 'success', 'warning']);
  expect(prunedButAsked(asked, registered, THEME_ICON_NAMES)).toEqual([]);
});

test('the built Trail Mix theme takes only the neutral theme’s icons, not its tokens', () => {
  const built = readFileSync(
    new URL('../../app/theme/built/trail-mix.js', import.meta.url),
    'utf8',
  );
  const kept = neutralIconsOnly(built);
  expect(kept).toStartWith(
    "import { neutralIconRegistry as themeIcons } from '@astryxdesign/theme-neutral/built';\n",
  );
  expect(kept).not.toMatch(/\bneutralTheme\b/);
  expect(kept).toContain('icons: themeIcons');
});

test('a module that reads more of the neutral theme keeps all of it', () => {
  const more = [
    "import { neutralTheme } from '@astryxdesign/theme-neutral/built';",
    'const themeIcons = neutralTheme["icons"];',
    'export const tokens = neutralTheme.tokens;',
    '',
  ].join('\n');
  expect(neutralIconsOnly(more)).toBe(more);
});
