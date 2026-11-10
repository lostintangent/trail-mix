import { createRootRoute, HeadContent, ScriptOnce, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { prepaintScript } from './prepaint.ts';
// Start links the root route's stylesheet in the shell's head, so it loads before first paint.
import './global.css';

export const Route = createRootRoute({
  // No route renders on the server. The Worker answers a page request with this shell alone, and
  // the app renders into it in the browser.
  ssr: false,
  shellComponent: Shell,
});

/**
 * The document every page starts as: plain HTML, with no Astryx or StyleX rendered in it. It names
 * the theme on `<html>`, so the desk is painted in the theme's colors before any module runs, and
 * the prepaint script applies the device's Light or Dark choice before that first paint.
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
