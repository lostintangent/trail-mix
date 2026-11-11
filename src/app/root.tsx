import {
  createRootRouteWithContext,
  HeadContent,
  ScriptOnce,
  Scripts,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { prepaintScript } from './prepaint.ts';
import { DESK_HEX } from './theme/palette.ts';
import type { RouterContext } from './router.tsx';
// Start links the root route's stylesheet in the shell's head, so it loads before first paint.
import './global.css';

export const Route = createRootRouteWithContext<RouterContext>()({
  // No route renders on the server. The Worker answers a page request with this shell alone, and
  // the app renders into it in the browser.
  ssr: false,
  shellComponent: Shell,
});

/**
 * The document every page starts as: plain HTML, with no Astryx or StyleX rendered in it. It names
 * the theme on `<html>`, so the desk is painted in the theme's colors before any module runs, in
 * the system's light or dark, which the browser's own chrome takes too, by one `theme-color` meta
 * per scheme. The prepaint script applies the accent and the panes' widths before that first
 * paint. Its
 * manifest and icons let a device install Trail Mix as an app.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-astryx-theme="trail-mix" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <title>Trail Mix</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {/* Access answers a request without the member's cookie with its sign-in page, and a
            manifest goes without one unless it asks. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={DESK_HEX.light} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={DESK_HEX.dark} />
        <ScriptOnce>{prepaintScript}</ScriptOnce>
        {import.meta.env.DEV && <StyleXDevelopment />}
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * In development StyleX serves its CSS live. Its runtime then moves that CSS into a style element
 * it keeps current and disables the link, before React adopts the document.
 */
function StyleXDevelopment() {
  return (
    <>
      <link rel="stylesheet" href="/virtual:stylex.css" suppressHydrationWarning />
      <script type="module" src="/@id/virtual:stylex:runtime" />
    </>
  );
}
