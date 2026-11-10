import { cloudflare } from '@cloudflare/vite-plugin';
import stylex from '@stylexjs/unplugin/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { index, rootRoute } from '@tanstack/virtual-file-routes';
import react from '@vitejs/plugin-react';
import { Features } from 'lightningcss';
import { defineConfig } from 'vite';
import { astryxIcons } from './src/shared/build/astryxIcons.ts';
import { astryxMessages } from './src/shared/build/astryxMessages.ts';
import { astryxUseTheme } from './src/shared/build/astryxUseTheme.ts';
import { serviceWorker } from './src/shared/build/serviceWorker.ts';
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
    // Astryx's message formatter and its fallback icons, kept to what the bundled components use,
    // and its theme generator, kept with the toasts, the only screen that runs it.
    astryxMessages(),
    astryxIcons(),
    astryxUseTheme(),
    // The installed app's service worker, `/sw.js`, which keeps this build for offline.
    serviceWorker({ entry: 'src/app/service-worker.ts' }),
    stylexDefinitionsFirst(),
    stylex(stylexOptions),
    react(),
  ],
}));
