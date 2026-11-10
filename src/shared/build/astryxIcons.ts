import type { Plugin } from 'vite';

const ASTRYX = '/@astryxdesign/';
const THEME_ICONS = '/@astryxdesign/theme-neutral/dist/icons.mjs';
const DEFAULT_ICONS = '/@astryxdesign/core/dist/Icon/defaultIcons.js';
const ENTRY = /^ {2}(\w+): \/\* @__PURE__ \*\/ jsx\(\w+, \{ \.\.\.iconProps \}\),?$/gm;
const QUOTED = /["'`](\w+)["'`]/g;
// Whole-line comments only, so a string such as 'image/*' can't swallow code.
const COMMENT = /^\s*(?:\/\*[\s\S]*?\*\/|\/\/.*$)/gm;

/**
 * The icons Astryx components in this app ask the theme for. The neutral theme registers 28
 * Lucide icons and Astryx bundles a heroicon-style fallback for each, all on the first load.
 * Field statuses map `error`, `warning`, and `success` to icons through lookup tables. `menu` and
 * `search` are only ARIA roles and input types in bundled code, but the guard can't tell, so a
 * kept icon is the safe answer.
 */
export const THEME_ICON_NAMES = new Set([
  'check',
  'chevronDown',
  'chevronLeft',
  'chevronRight',
  'close',
  'error',
  'info',
  'menu',
  'search',
  'success',
  'warning',
]);

/** The icon names a theme's icon module registers. */
export function registeredIcons(code: string): Set<string> {
  return new Set(Array.from(code.matchAll(ENTRY), ([, name]) => name!));
}

/**
 * Every quoted word in a module's code. Astryx reaches icons through props, hooks, and lookup
 * tables, so any string equal to an icon name counts as asked. A false positive only keeps an
 * icon. Comments are skipped, since their examples ask for nothing.
 */
export function quotedNames(code: string): Set<string> {
  return new Set(Array.from(code.replace(COMMENT, '').matchAll(QUOTED), ([, name]) => name!));
}

/** Registered icons that bundled code may ask for but `kept` would prune, sorted. */
export function prunedButAsked(
  asked: Iterable<string>,
  registered: ReadonlySet<string>,
  kept: ReadonlySet<string>,
): string[] {
  return [...new Set(asked)].filter((name) => registered.has(name) && !kept.has(name)).sort();
}

/**
 * Keeps only the theme icons the app uses, and drops Astryx's unused fallback set. The build
 * fails if a bundled Astryx module quotes a pruned icon name, or the theme stops registering a
 * kept one.
 */
export function astryxIcons(): Plugin {
  let registered = new Set<string>();
  const asked = new Set<string>();
  return {
    name: 'astryx-icons',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      registered = new Set();
      asked.clear();
    },
    transform(code, id) {
      if (id.endsWith(DEFAULT_ICONS)) return { code: 'export const defaultIcons = {};', map: null };
      if (id.endsWith(THEME_ICONS)) {
        registered = registeredIcons(code);
        for (const name of THEME_ICON_NAMES)
          if (!registered.has(name)) this.error(`The theme no longer registers a "${name}" icon.`);
        return {
          code: code.replace(ENTRY, (line, name: string) =>
            THEME_ICON_NAMES.has(name) ? line : '',
          ),
          map: null,
        };
      }
      if (id.includes(ASTRYX)) for (const name of quotedNames(code)) asked.add(name);
      return null;
    },
    buildEnd(error) {
      if (error) return;
      const missing = prunedButAsked(asked, registered, THEME_ICON_NAMES);
      if (missing.length)
        this.error(
          `Bundled Astryx code can ask for ${missing.join(', ')}. Add to THEME_ICON_NAMES.`,
        );
    },
  };
}
