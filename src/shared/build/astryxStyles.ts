import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { transform } from 'lightningcss';
import { parseSync, type Plugin } from 'vite';

/** Astryx's stylesheet, which holds every rule of every component, precompiled. */
const ASTRYX_CSS = '@astryxdesign/core/astryx.css';
/** What only Astryx's stylesheet declares, which marks a stylesheet that holds it. */
const HELD = '@layer astryx-base';
const ASTRYX = /^@astryxdesign\//;
const TOKEN = /[A-Za-z_][\w-]*/g;

/**
 * Astryx's stylesheet holds every rule of every component, about 40 KB gzip of the stylesheet that
 * blocks first paint. This keeps it to the rules the app's Astryx code can use. Astryx's components
 * name their classes as literal strings, so a class no bundled module names can never be on an
 * element, and a rule that needs one never applies. Such a rule goes. Rules without a class, such
 * as `:root`, `@property` and `@keyframes`, all stay, and so does a rule that needs a class only
 * inside `:not()`, `:is()` or `:where()`.
 *
 * What the app's Astryx code names is read before any stylesheet is built, from every Astryx module
 * that the app's source imports or reaches through those imports, so the stylesheet's hashed name
 * changes whenever what it keeps does. That walk takes in more modules than the bundle keeps, which
 * only keeps more rules. The build fails if a client chunk names an Astryx class the walk missed.
 */
export function astryxStyles(): Plugin {
  let root = '';
  // For each environment's build: Astryx's classes, the words its code names, and whether a
  // stylesheet held its rules.
  const builds = new Map<
    string,
    { classes: Promise<Set<string>>; named: Promise<Set<string>>; isPruned: boolean }
  >();
  return {
    name: 'astryx-styles',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      const resolveId = async (specifier: string, importer: string) => {
        const resolved = await this.resolve(specifier, importer);
        if (!resolved) throw new Error(`${specifier}, imported by ${importer}, doesn't resolve.`);
        return resolved.id.replace(/\?.*$/, '');
      };
      const app = join(root, 'src');
      builds.set(this.environment.name, {
        classes: resolveId(ASTRYX_CSS, join(app, 'app')).then(
          (file) => classesOf(readFileSync(file, 'utf8')).named,
        ),
        named: namedByAstryx(sourcesOf(app), resolveId),
        isPruned: false,
      });
    },
    async transform(code, id) {
      // Vite has built the stylesheet by now, with the stylesheets it imports inlined.
      const build = builds.get(this.environment.name);
      if (!build || !/\.css$/.test(id) || !code.includes(HELD)) return null;
      const [classes, named] = await Promise.all([build.classes, build.named]);
      build.isPruned = true;
      return { code: pruned(code, (name) => classes.has(name) && !named.has(name)), map: null };
    },
    async generateBundle(_, bundle) {
      const build = builds.get(this.environment.name);
      if (this.environment.name !== 'client' || !build) return;
      if (!build.isPruned) {
        this.error(`No stylesheet the build made held ${ASTRYX_CSS}, so nothing was pruned.`);
      }
      const [classes, named] = await Promise.all([build.classes, build.named]);
      const missed = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const [token] of output.code.matchAll(TOKEN)) {
          if (classes.has(token) && !named.has(token)) missed.add(token);
        }
      }
      if (missed.size) {
        this.error(
          `Client chunks name Astryx classes that no module the app imports names: ` +
            `${[...missed].slice(0, 10).join(', ')}. Their rules were pruned.`,
        );
      }
    },
  };
}

/** `css` without the style rules each of whose selectors needs a class that `isGone`. */
export function pruned(css: string, isGone: (name: string) => boolean): string {
  return transform({
    filename: 'astryx.css',
    code: Buffer.from(css),
    errorRecovery: false,
    visitor: {
      Rule: {
        style(rule) {
          const isDead = rule.value.selectors.every((selector) =>
            selector.some((part) => part.type === 'class' && isGone(part.name)),
          );
          return isDead ? [] : undefined;
        },
      },
    },
  }).code.toString();
}

/**
 * The classes the selectors in `css` name: every one, inside `:not()` and the like too, and those a
 * selector needs an element to carry, which are the only ones whose absence prunes a rule.
 */
export function classesOf(css: string): { named: Set<string>; required: Set<string> } {
  const named = new Set<string>();
  const required = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (typeof value === 'object' && value !== null) {
      if ('type' in value && value.type === 'class' && 'name' in value)
        named.add(String(value.name));
      for (const item of Object.values(value)) visit(item);
    }
  };
  transform({
    filename: 'stylesheet.css',
    code: Buffer.from(css),
    visitor: {
      Rule: {
        style(rule) {
          visit(rule.value.selectors);
          for (const selector of rule.value.selectors) {
            for (const part of selector) if (part.type === 'class') required.add(part.name);
          }
        },
      },
    },
  });
  return { named, required };
}

/**
 * Every word in every Astryx module the `sources` import, directly or through other Astryx
 * modules. Class names are among them, as Astryx's components write them out whole.
 */
export async function namedByAstryx(
  sources: Iterable<{ file: string; code: string }>,
  resolveId: (specifier: string, importer: string) => Promise<string>,
): Promise<Set<string>> {
  const words = new Set<string>();
  const seen = new Set<string>();
  const next: Promise<string>[] = [];
  for (const { file, code } of sources) {
    for (const specifier of importsOf(file, code)) {
      if (ASTRYX.test(specifier)) next.push(resolveId(specifier, file));
    }
  }
  while (next.length) {
    const file = await next.pop()!;
    if (seen.has(file) || !/\.m?js$/.test(file)) continue;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const [word] of code.matchAll(TOKEN)) words.add(word);
    for (const specifier of importsOf(file, code)) {
      if (specifier.startsWith('.')) next.push(Promise.resolve(resolve(dirname(file), specifier)));
      else if (ASTRYX.test(specifier)) next.push(resolveId(specifier, file));
    }
  }
  return words;
}

/** What a module imports, exports from, or imports dynamically by a literal name. */
function importsOf(file: string, code: string): string[] {
  const { module } = parseSync(file, code);
  return [
    ...module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) => (moduleRequest ? [moduleRequest.value] : [])),
    ),
    ...module.dynamicImports.flatMap(({ moduleRequest }) => {
      const literal = /^(["'`])([^"'`$]+)\1$/.exec(
        code.slice(moduleRequest.start, moduleRequest.end),
      );
      return literal ? [literal[2]!] : [];
    }),
  ];
}

/** The app's source files, tests aside. */
function sourcesOf(folder: string): { file: string; code: string }[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
    .map((path) => {
      const file = join(folder, path);
      return { file, code: readFileSync(file, 'utf8') };
    });
}
