import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { prunedButAsked, quotedNames, registeredIcons, THEME_ICON_NAMES } from './astryxIcons.ts';

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
