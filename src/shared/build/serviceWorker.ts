import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Emits `sw.js` beside the client build: the service worker's entry bundled with Bun, and handed
 * its build as `BUILD`: every file the build serves, by path, and a version that changes when any
 * of them does, so an unchanged build is no update at all.
 */
export function serviceWorker({ entry }: { entry: string }): Plugin {
  let publicDir = '';
  return {
    name: 'trail-mix-service-worker',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        if (typeof Bun === 'undefined') throw new Error('The service worker is bundled with Bun.');
        const built = Object.values(bundle).map((file) => ({
          path: `/${file.fileName}`,
          content: file.type === 'asset' ? file.source : file.code,
        }));
        // What the build copies from `public/`, by its path there.
        const copied = await Array.fromAsync(new Bun.Glob('**').scan(publicDir), async (path) => ({
          path: `/${path}`,
          content: await Bun.file(join(publicDir, path)).bytes(),
        }));
        const files = keptOf([...built, ...copied]);
        const source = await bundleWorker(entry, buildOf(files));
        this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      },
    },
  };
}

type File = { path: string; content: string | Uint8Array };

/** The files the worker keeps: what a page loads, not source maps or the build's own records. */
export function keptOf(files: readonly File[]): File[] {
  const byPath = new Map<string, File>();
  for (const file of files) {
    const isRecord =
      file.path.endsWith('.map') || file.path.split('/').some((part) => part.startsWith('.'));
    if (!isRecord && file.path !== '/sw.js' && !byPath.has(file.path)) byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The build the worker is handed: its files' paths, and a version over their names and bytes. */
export function buildOf(files: readonly File[]): { version: string; kept: string[] } {
  const hash = createHash('sha256');
  for (const { path, content } of files) hash.update(path).update(content);
  return { version: hash.digest('hex').slice(0, 16), kept: files.map(({ path }) => path) };
}

async function bundleWorker(entry: string, build: { version: string; kept: string[] }) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    minify: true,
    define: { BUILD: JSON.stringify(build) },
  });
  const [output] = result.outputs;
  if (!result.success || !output) throw new AggregateError(result.logs, 'sw.js did not build.');
  return output.text();
}
