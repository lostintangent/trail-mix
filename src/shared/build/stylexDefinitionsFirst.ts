import { globSync } from 'node:fs';
import { normalizePath, type Plugin } from 'vite';

/** Where StyleX's Vite plugin serves the development stylesheet. */
const DEV_CSS_PATH = '/virtual:stylex.css';

/**
 * In development StyleX builds its stylesheet from the rules of every module transformed so far,
 * and a constant from `stylex.defineConsts`, such as a media query, resolves only from the rules of
 * the `.stylex.ts` file that defines it. A browser asks for a module before that module's imports,
 * so on a cold start the stylesheet could be built from a component whose constants were not known
 * yet. Each such rule then lost its media query, and lightningcss rejected the whole stylesheet as
 * "Invalid empty selector".
 *
 * This holds every request for the stylesheet until each `.stylex.ts` file has been transformed.
 * Vite caches transforms, so after the first request the wait is a cache lookup. StyleX's plugin
 * answers the request and runs in the `pre` stage, so this one does too and must be listed first.
 */
export function stylexDefinitionsFirst(): Plugin {
  return {
    name: 'trail-mix:stylex-definitions-first',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (!request.url?.startsWith(DEV_CSS_PATH)) return next();
        const client = server.environments.client;
        const definitions = globSync('src/**/*.stylex.ts', { cwd: server.config.root });
        Promise.all(
          definitions.map((file) => client.warmupRequest(`/${normalizePath(file)}`)),
        ).then(() => next(), next);
      });
    },
  };
}
