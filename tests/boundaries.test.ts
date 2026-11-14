import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path/posix';

/**
 * Who may import what, checked against the import graph of `src` and `tests`, and what a type may
 * be named.
 *
 * - Features reach each other only through an `index.ts`.
 * - A `core` module is framework-free: nothing it imports, directly or through other modules, may
 *   be React, Astryx, StyleX, Cloudflare or a mail library.
 * - One name, one meaning: no two modules of `src` export a type or an interface of the same name.
 *   A re-export declares nothing, and a class is the one meaning of the type it implements.
 *
 * Imports are read from source text, so `import type` counts. A type borrowed from another
 * feature's internals couples the two features just as a value does.
 */

/** Source text by repository-relative path. */
type Sources = Record<string, string>;

/** What each module imports: other modules of the repository, and packages by specifier. */
type Graph = Map<string, { modules: string[]; packages: string[] }>;

/** What a core may never reach. A new mail library is added to the last pattern. */
const FRAMEWORKS: [name: string, specifier: RegExp][] = [
  ['React', /(^|\/|-)react(-|\/|$)/],
  ['Astryx', /^@astryxdesign\//],
  ['StyleX', /^@stylexjs\//],
  ['Cloudflare', /^(cloudflare:|@cloudflare\/)/],
  ['a mail library', /^(imapflow|nodemailer|postal-mime|mailparser)(\/|$)/],
];

const FEATURE = /^src\/features\/([^/]+)\//;
const CORE_MODULE = /^src\/features\/(?:[^/]+\/)+core\/(?!.*\.test\.tsx?$)/;
const EXPORTED_TYPE = /^export\s+(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm;

test('a feature may use its own modules and the index.ts of another feature', () => {
  const graph = importGraph({
    'src/features/mail/core/index.ts': "export * from './model.ts';",
    'src/features/mail/core/model.ts': 'export type AccountId = string;',
    'src/features/reader/ui/Reader.tsx': [
      "import type { AccountId } from '../../mail/core/index.ts';",
      "import { foldQuotes } from '../core/quotes.ts';",
    ].join('\n'),
    'src/features/reader/core/quotes.ts': 'export const foldQuotes = (text: string) => text;',
  });

  expect(featureShortcuts(graph)).toEqual([]);
  expect(impureCores(graph)).toEqual([]);
});

test('a feature that reaches past the index.ts of another feature is reported', () => {
  const graph = importGraph({
    'src/features/mail/core/model.ts': 'export type AccountId = string;',
    'src/features/mailroom/server/schema.ts': 'export const versions = [];',
    'src/features/reader/ui/Reader.tsx': "import type { AccountId } from '../../mail/core/model';",
    'src/features/outbox/ui/Outbox.tsx':
      "const schema = await import('../../mailroom/server/schema.ts');",
  });

  expect(featureShortcuts(graph)).toEqual([
    'src/features/reader/ui/Reader.tsx imports src/features/mail/core/model.ts',
    'src/features/outbox/ui/Outbox.tsx imports src/features/mailroom/server/schema.ts',
  ]);
});

test('a core that reaches a framework through other modules is reported with the path it took', () => {
  const graph = importGraph({
    'src/features/composer/core/render.ts': "import { toolbar } from '../ui/toolbar.ts';",
    'src/features/composer/ui/toolbar.ts': "export { Toolbar as toolbar } from './Toolbar.tsx';",
    'src/features/composer/ui/Toolbar.tsx': "import { useState } from 'react';",
    'src/features/providers/imap/core/sync.ts': "import type { ImapFlow } from 'imapflow';",
    'src/features/providers/imap/core/sync.test.ts': "import { env } from 'cloudflare:workers';",
  });

  expect(impureCores(graph)).toEqual([
    'src/features/composer/core/render.ts -> src/features/composer/ui/toolbar.ts -> src/features/composer/ui/Toolbar.tsx -> react (React)',
    'src/features/providers/imap/core/sync.ts -> imapflow (a mail library)',
  ]);
});

test('a type name exported by two modules of src is reported with both', () => {
  expect(
    homonyms({
      'src/features/mail/core/place.ts': 'export type Place = { view: string };',
      'src/features/folders/core/names.ts': 'export type Place<Path> = { parent: Path };',
      'src/features/mail/core/model.ts': 'export interface Moved {\n  from: string;\n}',
      'src/features/providers/provider.ts': 'export interface Moved {}',
    }),
  ).toEqual([
    'Place: src/features/mail/core/place.ts, src/features/folders/core/names.ts',
    'Moved: src/features/mail/core/model.ts, src/features/providers/provider.ts',
  ]);
});

test('a re-export, a class, a private type and a test outside src declare no homonym', () => {
  expect(
    homonyms({
      'src/features/mail/core/model.ts': 'export type Moved = { from: string };',
      'src/features/mail/core/index.ts': "export type { Moved } from './model.ts';",
      'src/features/providers/index.ts': "export { type Moved } from '../mail/core/index.ts';",
      'src/features/outbox/core/sending.ts': 'type Moved = string;',
      'tests/e2e/suite.ts': 'export type Moved = number;',
      'src/server/access.ts': 'export type VisitorGate = { admit(): boolean };',
      'src/server/visitors.ts': 'export class VisitorGate {}',
    }),
  ).toEqual([]);
});

test('the repository keeps every rule', async () => {
  const sources = await repositorySources();
  const graph = importGraph(sources);

  expect(graph.has('tests/boundaries.test.ts')).toBe(true);
  expect(featureShortcuts(graph)).toEqual([]);
  expect(impureCores(graph)).toEqual([]);
  expect(homonyms(sources)).toEqual([]);
});

/** Imports between two features that do not land on an `index.ts`. */
function featureShortcuts(graph: Graph): string[] {
  const shortcuts: string[] = [];
  for (const [path, { modules }] of graph) {
    const feature = FEATURE.exec(path)?.[1];
    if (!feature) continue;
    for (const target of modules) {
      const owner = FEATURE.exec(target)?.[1];
      if (owner && owner !== feature && !target.endsWith('/index.ts')) {
        shortcuts.push(`${path} imports ${target}`);
      }
    }
  }
  return shortcuts;
}

/** Every path from a core module to a framework, walked breadth first through the repository. */
function impureCores(graph: Graph): string[] {
  const reached: string[] = [];
  for (const core of graph.keys()) {
    if (!CORE_MODULE.test(core)) continue;
    const seen = new Set([core]);
    const queue = [[core]];
    for (let chain = queue.shift(); chain; chain = queue.shift()) {
      const imports = graph.get(chain.at(-1) ?? core);
      for (const specifier of imports?.packages ?? []) {
        const framework = FRAMEWORKS.find(([, pattern]) => pattern.test(specifier));
        if (framework) reached.push(`${[...chain, specifier].join(' -> ')} (${framework[0]})`);
      }
      for (const next of imports?.modules ?? []) {
        if (!seen.has(next)) queue.push([...chain, next]);
        seen.add(next);
      }
    }
  }
  return reached;
}

/** Each type name that more than one module of `src` declares and exports, with those modules. */
function homonyms(sources: Sources): string[] {
  const declared = new Map<string, string[]>();
  for (const [path, source] of Object.entries(sources)) {
    if (!path.startsWith('src/')) continue;
    for (const [, name = ''] of source.matchAll(EXPORTED_TYPE)) {
      declared.set(name, [...(declared.get(name) ?? []), path]);
    }
  }
  return [...declared]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => `${name}: ${paths.join(', ')}`);
}

function importGraph(sources: Sources): Graph {
  const paths = new Set(Object.keys(sources));
  const graph: Graph = new Map();
  for (const [path, source] of Object.entries(sources)) {
    const modules: string[] = [];
    const packages: string[] = [];
    for (const specifier of importsIn(source)) {
      if (!specifier.startsWith('.')) {
        packages.push(specifier);
        continue;
      }
      // A relative import of a stylesheet or an asset is not a module of the graph.
      const target = join(dirname(path), specifier);
      const module = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`].find(
        (candidate) => paths.has(candidate),
      );
      if (module) modules.push(module);
    }
    graph.set(path, { modules, packages });
  }
  return graph;
}

/** The specifier of every static import, re-export and literal dynamic import, types included. */
function importsIn(source: string): string[] {
  const statements =
    /^\s*(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]|^\s*import\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]/gm;
  return [...source.matchAll(statements)].flatMap((match) => match.slice(1).filter(Boolean));
}

async function repositorySources(): Promise<Sources> {
  const root = join(import.meta.dir, '..');
  const sources: Sources = {};
  for await (const path of new Bun.Glob('{src,tests}/**/*.{ts,tsx}').scan({ cwd: root })) {
    sources[path] = await Bun.file(join(root, path)).text();
  }
  return sources;
}
