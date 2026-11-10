import { expect, test } from 'bun:test';
import stylex from '@stylexjs/unplugin/vite';
import { dirname, join, resolve } from 'node:path';
import { stylexOptions } from './stylexOptions.ts';

/**
 * Atomic StyleX classes hash only the property and value. Astryx ships its CSS precompiled with
 * StyleX's default `x` prefix, so a class of ours with the same name would carry our declaration in
 * a later layer and drop the states Astryx attaches to it, such as a menu item's focus background.
 * The app's own prefix keeps the two sets disjoint, and these tests hold it to that. They also hold
 * StyleX's layers after Astryx's, so a component's `xstyle` wins over Astryx's own styles.
 */

const ROOT = resolve(import.meta.dir, '../../..');

interface StylexPlugin {
  transform(this: unknown, code: string, id: string): Promise<unknown>;
  __stylexGetSharedStore(): { rulesById: Map<string, [string, ...unknown[]][]> };
}

const GLOBAL_CSS = join(ROOT, 'src/app/global.css');

test("no StyleX class of ours shares a name with Astryx's stylesheet", async () => {
  const ours = await appClasses(stylexOptions.classNamePrefix);
  const theirs = stylesheetClasses(await stylesheets(GLOBAL_CSS));

  expect(ours.size).toBeGreaterThan(0);
  expect(theirs.size).toBeGreaterThan(1000);
  expect(shared(ours, theirs)).toEqual([]);
}, 30_000);

test("the check finds the clash that Astryx's own prefix would cause", async () => {
  const ours = await appClasses('x');
  const theirs = stylesheetClasses(await stylesheets(GLOBAL_CSS));

  expect(shared(ours, theirs).length).toBeGreaterThan(0);
}, 30_000);

test("StyleX's layers come after every layer Astryx's stylesheet declares", async () => {
  const theirs = stylesheetLayers(await stylesheets(GLOBAL_CSS));

  expect(theirs.length).toBeGreaterThan(0);
  expect(theirs).toEqual([...stylexOptions.useCSSLayers.before]);
});

/** Every class the app's sources generate, by the file that generates it. */
async function appClasses(classNamePrefix: string): Promise<Map<string, string>> {
  const plugin = stylex({ ...stylexOptions, classNamePrefix }) as unknown as StylexPlugin;
  const classes = new Map<string, string>();
  for await (const file of new Bun.Glob('src/**/*.{ts,tsx}').scan({ cwd: ROOT })) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const id = join(ROOT, file);
    const code = await Bun.file(id).text();
    if (!code.includes('@stylexjs/stylex')) continue;
    await plugin.transform.call({}, code, id);
    for (const [name] of plugin.__stylexGetSharedStore().rulesById.get(id) ?? []) {
      classes.set(name, file);
    }
  }
  return classes;
}

/** A stylesheet and every stylesheet it `@import`s, depth first, without comments or URLs. */
async function stylesheets(entry: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const css = await Bun.file(entry).text();
  const sheets: string[] = [];
  for (const [, specifier = ''] of css.matchAll(/@import\s+['"]([^'"]+)['"]/g)) {
    const path = specifier.startsWith('.')
      ? resolve(dirname(entry), specifier)
      : Bun.resolveSync(specifier, ROOT);
    sheets.push(...(await stylesheets(path, seen)));
  }
  sheets.push(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, ''));
  return sheets;
}

function stylesheetClasses(sheets: string[]): Set<string> {
  const classes = new Set<string>();
  for (const css of sheets) {
    for (const [, name = ''] of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(name);
  }
  return classes;
}

/** Every cascade layer the stylesheets name, in the order they first name it. */
function stylesheetLayers(sheets: string[]): string[] {
  const layers: string[] = [];
  for (const css of sheets) {
    for (const [, names = ''] of css.matchAll(/@layer\s+([^{;]+)[{;]/g)) {
      for (const name of names.split(',').map((layer) => layer.trim())) {
        if (name && !layers.includes(name)) layers.push(name);
      }
    }
  }
  return layers;
}

function shared(ours: Map<string, string>, theirs: Set<string>): string[] {
  return [...ours].filter(([name]) => theirs.has(name)).map(([name, file]) => `${name} (${file})`);
}
