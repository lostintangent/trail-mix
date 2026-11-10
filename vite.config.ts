import { cloudflare } from '@cloudflare/vite-plugin';
import stylex from '@stylexjs/unplugin/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { index, rootRoute } from '@tanstack/virtual-file-routes';
import react from '@vitejs/plugin-react';
import { Features } from 'lightningcss';
import { defineConfig } from 'vite';
import { stylexDefinitionsFirst } from './src/shared/build/stylexDefinitionsFirst.ts';
import { stylexOptions } from './src/shared/build/stylexOptions.ts';

export default defineConfig(({ isPreview }) => ({
  // The build's CSS minifier would lower light-dark() into variables only <html> switches, so a
  // sheet that sets its own color-scheme, such as mail on light paper, couldn't flip a token.
  css: { lightningcss: { exclude: Features.LightDark } },
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
