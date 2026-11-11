import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classesOf, namedByAstryx, pruned } from './astryxStyles.ts';

const gone =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name);

test('a rule goes when each of its selectors needs a class that is gone', () => {
  const css = '.a{--one:1}.b{--two:2}.a.c{--three:3}.b .a{--four:4}.b,.a{--five:5}';
  const kept = pruned(css, gone('a'));
  for (const name of ['--one', '--three', '--four']) expect(kept).not.toContain(name);
  // A list with a selector that can still match stays whole.
  for (const name of ['--two', '--five']) expect(kept).toContain(name);
});

test('a rule stays when it needs a gone class only inside :not(), :is() or :where()', () => {
  const css = '.b:not(.a){color:red}:is(.a,.b){color:blue}:where(.a) .b{color:green}';
  expect(pruned(css, gone('a'))).toBe(pruned(css, gone()));
});

test("a class named only inside :where() prunes nothing, as StyleX's marker doesn't", () => {
  const css = '.b:where(.x-default-marker:hover *){--a:1}';
  expect(classesOf(css)).toEqual({
    named: new Set(['b', 'x-default-marker']),
    required: new Set(['b']),
  });
  expect(pruned(css, gone('x-default-marker'))).toContain('--a');
});

test("rules without a class all stay, and the theme's colors keep their light-dark()", () => {
  const css = [
    ':root{--x:1px}',
    '@property --y{syntax:"*";inherits:false}',
    '@keyframes spin{to{rotate:1turn}}',
    '[data-astryx-theme] a{color:red}',
    '@layer astryx-base{@media (pointer:coarse){.a{color:red}.b{color:blue}}}',
    '@starting-style{.a{opacity:0}}',
    '.b{color:light-dark(#fff,#000)}',
  ].join('');
  const kept = pruned(css, gone('a'));
  for (const part of ['--x', '@property --y', '@keyframes spin', '[data-astryx-theme] a', '.b'])
    expect(kept).toContain(part);
  expect(kept).toContain('light-dark(');
  expect(classesOf(kept).named).toEqual(new Set(['b']));
});

test("Astryx's walk follows imports through its modules, and not code that only mentions one", async () => {
  const folder = mkdtempSync(join(tmpdir(), 'astryx-styles-'));
  const write = (name: string, code: string) => {
    writeFileSync(join(folder, name), code);
    return join(folder, name);
  };
  write('Button.js', 'import { press } from "./press.js";\nexport const Button = "xbutton";');
  write('press.js', 'export const press = "xpress";');
  write('Menu.js', 'export const Menu = "xmenu";');
  write('lazy.js', 'export const lazy = "xlazy";');
  write(
    'index.js',
    [
      'export * from "./Button.js";',
      'const load = () => import("./lazy.js");',
      'const note = `import {${name}} from "@astryxdesign/theme-${name}/built"`;',
    ].join('\n'),
  );
  const asked: string[] = [];
  const resolveId = (specifier: string) => {
    asked.push(specifier);
    return Promise.resolve(join(folder, 'index.js'));
  };
  const sources = [
    { file: 'app.tsx', code: "import { Button } from '@astryxdesign/core';\nimport 'react';" },
  ];
  try {
    const named = await namedByAstryx(sources, resolveId);
    expect(['xbutton', 'xpress', 'xlazy'].every((name) => named.has(name))).toBe(true);
    expect(named.has('xmenu')).toBe(false);
    expect(asked).toEqual(['@astryxdesign/core']);
  } finally {
    rmSync(folder, { recursive: true });
  }
});
