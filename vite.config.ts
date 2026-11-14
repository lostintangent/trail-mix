import { cloudflare } from '@cloudflare/vite-plugin';
import stylex from '@stylexjs/unplugin/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { index, rootRoute } from '@tanstack/virtual-file-routes';
import react from '@vitejs/plugin-react';
import { Features } from 'lightningcss';
import { defineConfig } from 'vite';
import { astryxBuiltTheme } from './src/shared/build/astryxBuiltTheme.ts';
import { astryxIcons } from './src/shared/build/astryxIcons.ts';
import { astryxStyles } from './src/shared/build/astryxStyles.ts';
import { astryxMessages } from './src/shared/build/astryxMessages.ts';
import { astryxUseTheme } from './src/shared/build/astryxUseTheme.ts';
import { preloadMissing } from './src/shared/build/preloadMissing.ts';
import { serviceWorker } from './src/shared/build/serviceWorker.ts';
import { stylexDefinitionsFirst } from './src/shared/build/stylexDefinitionsFirst.ts';
import { stylexOptions } from './src/shared/build/stylexOptions.ts';
import { workerModules } from './src/shared/build/workerModules.ts';

/** Where a test's preview keeps its storage, as `tests/e2e/preview.ts` sets it. */
const TEST_STATE = process.env.TRAIL_MIX_TEST_STATE;

export default defineConfig(({ isPreview }) => ({
  // The build's CSS minifier would lower light-dark() into variables only <html> switches, so a
  // sheet that sets its own color-scheme, such as mail on light paper, couldn't flip a token.
  css: { lightningcss: { exclude: Features.LightDark } },
  plugins: [
    cloudflare({
      // The Worker, `src/server/entry.ts`, runs on workerd in development, preview and production.
      viteEnvironment: { name: 'ssr' },
      // Development and preview keep separate local storage, so both can run at once. A test's
      // preview names a fresh place of its own, so it starts empty, as it does in CI, and has no
      // inspector, whose port the plugin picks before binding it, so a preview starting alongside
      // could take it first.
      persistState: {
        path: TEST_STATE ?? (isPreview ? '.wrangler/preview' : '.wrangler/state'),
      },
      ...(TEST_STATE !== undefined && { inspectorPort: false }),
    }),
    tanstackStart({
      router: {
        entry: 'app/router.tsx',
        routesDirectory: '.',
        generatedRouteTree: 'app/routeTree.gen.ts',
        virtualRouteConfig: rootRoute('app/root.tsx', [index('app/workbench.tsx')]),
        addExtensions: true,
        // Start hands these to the server build's code splitter alone. The Worker renders no route,
        // only the shell, so it drops every route's component, and the app's UI with it, from what
        // each of its isolates loads.
        codeSplittingOptions: { deleteNodes: ['component'] },
      },
      client: { entry: 'app/main.tsx' },
    }),
    // Astryx's message formatter and its fallback icons, kept to what the bundled components use,
    // and its theme generator, kept with the toasts, the only screen that runs it.
    astryxMessages(),
    astryxIcons(),
    astryxUseTheme(),
    // A built theme's fields that only generate its CSS, which its stylesheet already holds. The
    // e2e suite drives a build that throws where Astryx reads one.
    astryxBuiltTheme({ isTrapped: process.env.THEME_TRAPS === '1' }),
    // Astryx's stylesheet, kept to the rules whose classes Astryx code the app imports names.
    astryxStyles(),
    // The installed app's service worker, `/sw.js`, which keeps this build for offline.
    serviceWorker({ entry: 'src/app/service-worker.ts' }),
    workerModules(),
    // Each lazy import's preload list, kept to the chunks its importer hasn't already loaded.
    preloadMissing(),
    stylexDefinitionsFirst(),
    stylex(stylexOptions),
    react(),
  ],
}));
