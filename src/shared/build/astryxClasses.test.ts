import { expect, test } from 'bun:test';
import stylex from '@stylexjs/unplugin/vite';
import { dirname, join, resolve } from 'node:path';
import { stylexOptions } from './stylexOptions.ts';

/**
 * Atomic StyleX classes hash only the property and value. Astryx ships its CSS precompiled with
 * StyleX's default `x` prefix, so a class of ours with the same name would carry our declaration in
 * a later layer and drop the states Astryx attaches to it, such as a menu item's focus background.
 * The app's own prefix keeps the two sets disjoint, and these tests hold it to that.
 */

const ROOT = resolve(import.meta.dir, '../../..');

interface StylexPlugin {
  transform(this: unknown, code: string, id: string): Promise<unknown>;
  __stylexGetSharedStore(): { rulesById: Map<string, [string, ...unknown[]][]> };
}

test("no StyleX class of ours shares a name with Astryx's stylesheet", async () => {
  const ours = await appClasses(stylexOptions.classNamePrefix);
  const theirs = await stylesheetClasses(join(ROOT, 'src/app/global.css'));

  expect(ours.size).toBeGreaterThan(0);
  expect(theirs.size).toBeGreaterThan(1000);
  expect(shared(ours, theirs)).toEqual([]);
}, 30_000);

test("the check finds the clash that Astryx's own prefix would cause", async () => {
  const ours = await appClasses('x');
  const theirs = await stylesheetClasses(join(ROOT, 'src/app/global.css'));

  expect(shared(ours, theirs).length).toBeGreaterThan(0);
}, 30_000);

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

/** Class selectors in a stylesheet and every stylesheet it `@import`s. */
async function stylesheetClasses(entry: string, seen = new Set<string>()): Promise<Set<string>> {
  const classes = new Set<string>();
  if (seen.has(entry)) return classes;
  seen.add(entry);
  const css = await Bun.file(entry).text();
  for (const [, specifier = ''] of css.matchAll(/@import\s+['"]([^'"]+)['"]/g)) {
    const path = specifier.startsWith('.')
      ? resolve(dirname(entry), specifier)
      : Bun.resolveSync(specifier, ROOT);
    for (const name of await stylesheetClasses(path, seen)) classes.add(name);
  }
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
  for (const [, name = ''] of rules.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(name);
  return classes;
}

function shared(ours: Map<string, string>, theirs: Set<string>): string[] {
  return [...ours].filter(([name]) => theirs.has(name)).map(([name, file]) => `${name} (${file})`);
}
