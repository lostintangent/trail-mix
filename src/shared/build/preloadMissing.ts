import type { Plugin } from 'vite';

/**
 * Keeps each dynamic import's preload list to the chunks its importer can lack. Vite lists every
 * chunk a lazy module needs, so they load side by side rather than one after another. But a chunk
 * runs only once every chunk it imports statically has loaded, so naming those again in each of its
 * lists fetches nothing, and costs the first load the bytes of their names.
 */
export function preloadMissing(): Plugin {
  return {
    name: 'preload-missing',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    // Vite reads its preload options as it writes each list, once the bundle is known, so they are
    // given then, from that bundle.
    generateBundle: {
      order: 'pre',
      handler(_, bundle) {
        const { build } = this.environment.config;
        if (build.modulePreload === false) return;
        const lacks = lacking(bundle);
        const given = build.modulePreload.resolveDependencies;
        build.modulePreload = {
          ...build.modulePreload,
          resolveDependencies: (file, deps, context) => {
            const lacked = lacks(deps, context.hostId);
            return given ? given(file, lacked, context) : lacked;
          },
        };
      },
    },
  };
}

/** What `lacking` reads of each file Rolldown writes. */
type Output =
  | { type: 'chunk'; fileName: string; imports: readonly string[] }
  | { type: 'asset'; fileName: string };

/**
 * Which of a dynamic import's deps its importer, `host`, can lack: all but itself and the chunks it
 * imports statically, at any depth. An importer the bundle doesn't hold, such as a page, lacks them
 * all.
 */
export function lacking(
  bundle: Readonly<Record<string, Output>>,
): (deps: readonly string[], host: string) => string[] {
  const loaded = new Map<string, ReadonlySet<string>>();
  const loadedBy = (host: string) => {
    const known = loaded.get(host);
    if (known) return known;
    const reached = new Set<string>();
    const next = [host];
    for (let file = next.pop(); file !== undefined; file = next.pop()) {
      const chunk = bundle[file];
      if (reached.has(file) || chunk?.type !== 'chunk') continue;
      reached.add(file);
      next.push(...chunk.imports);
    }
    loaded.set(host, reached);
    return reached;
  };
  return (deps, host) => {
    const have = loadedBy(host);
    return deps.filter((dep) => !have.has(dep));
  };
}
