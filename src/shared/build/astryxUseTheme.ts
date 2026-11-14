import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { loadedAlongside } from './chunks.ts';

const DIST = '/@astryxdesign/core/dist/';
const USE_THEME = `${DIST}theme/useTheme.js`;
const GENERATOR = `${DIST}theme/generateThemeRules.js`;
/** The query that names the hook's own module, read from the file it was cut from. */
const HOOK = '?hook';
const HOOK_START = 'export function useTheme() {';
const IMPORT = /^import [^;]+;\n/gm;
const DECLARED = /^(?:export )?(?:function|const|let) ([\w$]+)/gm;
const EXPORTED = /^export (?:function|const|let) ([\w$]+)/gm;
const COMMENT = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
const RELATIVE = /from (["'])(\.\.?\/[^"']+)\1/g;

/**
 * Astryx's `useTheme` resolves every token through the theme generator, about 23 KiB gzip, and
 * only toasts call it, which load lazily. It shares `useTheme.js` with `useThemeName`, which every
 * `Icon` calls, and Rolldown places code by module rather than by export, so the generator rode on
 * the first load. This moves the hook into a module of its own, which what stays of the file
 * re-exports. Astryx's modules have no side effects, so only what calls the hook reaches the
 * generator.
 *
 * The build fails if `useTheme.js` changes so the split can't be made, if what stays of it would
 * still reach the generator, or if the chunk that holds it loads the generator anyway.
 */
export function astryxUseTheme(): Plugin {
  return {
    name: 'astryx-use-theme',
    apply: 'build',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    load(id) {
      if (!id.endsWith(USE_THEME + HOOK)) return null;
      const file = id.slice(0, -HOOK.length);
      const { hook } = splitUseTheme(readFileSync(file, 'utf8'));
      // Its imports name their files outright, since its own id carries a query.
      return hook.replace(RELATIVE, (_, quote: string, path: string) => {
        return `from ${quote}${resolve(dirname(file), path)}${quote}`;
      });
    },
    transform(code, id) {
      return id.endsWith(USE_THEME) ? { code: splitUseTheme(code).rest, map: null } : null;
    },
    generateBundle(_, bundle) {
      for (const { fileName } of loadedAlongside(bundle, USE_THEME, [GENERATOR])) {
        this.error(
          `Astryx's theme generator is in ${fileName}, which loads with useTheme.js, so it is ` +
            'back on the first load.',
        );
      }
    },
  };
}

/**
 * Cuts Astryx's `useTheme.js` in two: what stays, which drops the imports only the hook uses and
 * re-exports the hook, and the hook's own module, which imports what the file did and the file's
 * own helpers it calls. Throws if the hook isn't the file's last export, or if what stays still
 * imports `tokens.js`.
 */
export function splitUseTheme(code: string): { rest: string; hook: string } {
  const at = code.indexOf(HOOK_START);
  if (at < 0 || code.includes(HOOK_START, at + 1)) {
    throw new Error(`Astryx's useTheme.js no longer has one \`${HOOK_START}\` to move.`);
  }
  // The hook's doc comment goes with it.
  const doc = code.lastIndexOf('/**', at);
  const start = doc >= 0 && code.slice(code.indexOf('*/', doc) + 2, at).trim() === '' ? doc : at;
  const hookCode = code.slice(start);
  if (/^export /m.test(hookCode.slice(at - start + HOOK_START.length))) {
    throw new Error(
      "Astryx's useTheme.js exports something after useTheme, which would move with it.",
    );
  }

  const imports = code.slice(0, start).match(IMPORT) ?? [];
  const body = code.slice(0, start).replace(IMPORT, '');
  const dropped = imports.filter((line) => {
    const names = importedNames(line);
    return names.length > 0 && !names.some((name) => mentions(body, name));
  });
  const declared = Array.from(body.matchAll(DECLARED), ([, name]) => name!);
  const exported = new Set(Array.from(body.matchAll(EXPORTED), ([, name]) => name!));
  const shared = declared.filter((name) => mentions(hookCode, name));
  const toExport = shared.filter((name) => !exported.has(name));

  const rest =
    dropped.reduce((text, line) => text.replace(line, ''), code.slice(0, start)) +
    (toExport.length ? `export { ${toExport.join(', ')} };\n` : '') +
    `export { useTheme } from "./useTheme.js${HOOK}";\n`;
  if (/^import [^;]*"\.\/tokens\.js";$/m.test(rest)) {
    throw new Error(
      "What stays of Astryx's useTheme.js still imports tokens.js, so the theme generator would " +
        'stay on the first load.',
    );
  }
  const hook = `${imports.join('')}import { ${shared.join(', ')} } from "./useTheme.js";\n${hookCode}`;
  return { rest, hook };
}

/** The local names an import statement binds. A bare import binds none. */
function importedNames(line: string): string[] {
  const clause = /^import\s+([\s\S]*?)\s+from\s/.exec(line)?.[1] ?? '';
  return clause
    .split(/[{},]/)
    .map((item) =>
      item
        .trim()
        .split(/\s+as\s+/)
        .at(-1)!,
    )
    .filter(Boolean);
}

/** Whether code outside comments names `name` as a variable, not as a property. */
function mentions(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(
    code.replace(COMMENT, ''),
  );
}
