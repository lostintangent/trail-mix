import type { Plugin } from 'vite';
import { loadedWith, type Output } from './chunks.ts';

/**
 * Keeps the Worker's build to the modules its entry can reach. Rolldown writes a chunk for every
 * dynamic import it finds, even one whose importer tree-shaking then drops, as it drops the route
 * components the server never renders. workerd compiles every module a Worker uploads each time
 * it starts an isolate, so a module the Worker can never run still slows every start.
 */
export function workerModules(): Plugin {
  return {
    name: 'worker-modules',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'ssr',
    generateBundle(_, bundle) {
      for (const file of unreachable(bundle)) delete bundle[file];
    },
  };
}

/** The files of a bundle that no entry reaches by its imports, each with its source map. */
export function unreachable(bundle: Readonly<Record<string, Output>>): string[] {
  const chunks = Object.values(bundle).flatMap((output) =>
    output.type === 'chunk' ? [output] : [],
  );
  const entries = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  const reached = loadedWith(bundle, entries, true);
  return chunks
    .filter((chunk) => !reached.has(chunk.fileName))
    .flatMap(({ fileName }) => [fileName, `${fileName}.map`].filter((file) => file in bundle));
}
