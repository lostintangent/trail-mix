import { afterEach, beforeEach, expect, test } from 'bun:test';
import stylex from '@stylexjs/unplugin/vite';
import { resolve } from 'node:path';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { stylexDefinitionsFirst } from './stylexDefinitionsFirst.ts';
import { stylexOptions } from './stylexOptions.ts';

const ROOT = resolve(import.meta.dir, '../../..');

let server: ViteDevServer | undefined;
afterEach(() => server?.close());

// StyleX's plugin keeps the rules it has collected on `globalThis`, shared by every instance in the
// process, so each test starts from a cold store as a new dev server does.
beforeEach(() => {
  delete (globalThis as { __stylex_unplugin_store?: unknown }).__stylex_unplugin_store;
});

/**
 * A cold start as a browser makes it: the workbench is transformed before the `.stylex.ts` file
 * that defines its media queries, and then the development stylesheet is requested.
 */
async function coldStylesheet(plugins: Plugin[]): Promise<Response> {
  server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'silent',
    plugins,
    optimizeDeps: { noDiscovery: true, entries: [] },
    // Vite would otherwise start transforming the workbench's imports on its own, by chance.
    server: { port: 0, hmr: false, ws: false, preTransformRequests: false },
  });
  await server.listen();
  await server.environments.client.transformRequest('/src/features/workbench/ui/Workbench.tsx');
  return fetch(new URL('/virtual:stylex.css', server.resolvedUrls?.local[0]));
}

test('the development stylesheet resolves media queries on a cold start', async () => {
  const response = await coldStylesheet([
    stylexDefinitionsFirst(),
    stylex(stylexOptions) as Plugin,
  ]);

  expect(response.status).toBe(200);
  expect(await response.text()).toContain('@media (width < 768px)');
}, 30_000);

test('without it, the same cold start fails', async () => {
  const response = await coldStylesheet([stylex(stylexOptions) as Plugin]);

  expect(response.status).toBe(500);
}, 30_000);
