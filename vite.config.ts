import { cloudflare } from '@cloudflare/vite-plugin';
import stylex from '@stylexjs/unplugin/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { index, rootRoute } from '@tanstack/virtual-file-routes';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { stylexOptions } from './src/shared/build/stylexOptions.ts';

export default defineConfig({
  plugins: [
    // The Worker, `src/server/entry.ts`, runs on workerd in development, preview and production.
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
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
    stylex(stylexOptions),
    react(),
  ],
});
