import { cloudflare } from '@cloudflare/vite-plugin';
import stylex from '@stylexjs/unplugin/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { index, rootRoute } from '@tanstack/virtual-file-routes';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { stylexDefinitionsFirst } from './src/shared/build/stylexDefinitionsFirst.ts';
import { stylexOptions } from './src/shared/build/stylexOptions.ts';

export default defineConfig(({ isPreview }) => ({
  plugins: [
    cloudflare({
      // The Worker, `src/server/entry.ts`, runs on workerd in development, preview and production.
      viteEnvironment: { name: 'ssr' },
      // Development and preview keep separate local storage, so both can run at once.
      persistState: { path: isPreview ? '.wrangler/preview' : '.wrangler/state' },
    }),
    tanstackStart({
      router: {
        entry: 'app/router.tsx',
        routesDirectory: '.',
        generatedRouteTree: 'app/routeTree.gen.ts',
        virtualRouteConfig: rootRoute('app/root.tsx', [index('app/workbench.tsx')]),
        addExtensions: true,
      },
      client: { entry: 'app/main.tsx' },
    }),
    stylexDefinitionsFirst(),
    stylex(stylexOptions),
    react(),
  ],
}));
