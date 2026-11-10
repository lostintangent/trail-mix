import stylex from '@stylexjs/unplugin/vite';
import react from '@vitejs/plugin-react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserType } from 'playwright';
import { build } from 'vite';
import { stylexOptions } from '../../src/shared/build/stylexOptions.ts';

/**
 * What the reader's browser tests stand on: the harness page built as the app is built, a server
 * for it that plays the Worker's image proxy and message parts, and a canary, a server on another
 * origin that stands in for every remote host and records each request that reaches it.
 */

export type Harness = {
  origin: string;
  /** The remote URLs the image proxy was asked for. */
  proxied: string[];
  /** The paths of message parts that were requested. */
  parts: string[];
  stop: () => void;
};

export type Canary = {
  origin: string;
  /** Host and port, for mail that names a server without a scheme. */
  host: string;
  /** Every request that reached it: its path, and its Referer if it carried one. */
  hits: { path: string; referer: string | null }[];
  stop: () => void;
};

/** A 1x1 transparent PNG: what the proxy and the parts answer with. */
const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);

export async function serveHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'trail-mix-reader-'));
  await build({
    root: join(import.meta.dir, 'harness'),
    configFile: false,
    logLevel: 'silent',
    plugins: [stylex(stylexOptions), react()],
    build: { outDir: dir, emptyOutDir: true },
  });
  const proxied: string[] = [];
  const parts: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/images') {
        proxied.push(url.searchParams.get('url') ?? '');
        return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
      }
      if (url.pathname.startsWith('/messages/')) {
        parts.push(url.pathname);
        return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
      }
      const file = Bun.file(join(dir, url.pathname === '/' ? 'index.html' : url.pathname));
      return file
        .exists()
        .then((exists) => new Response(exists ? file : null, { status: exists ? 200 : 404 }));
    },
  });
  return {
    origin: server.url.origin,
    proxied,
    parts,
    stop: () => {
      void server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function serveCanary(): Canary {
  const hits: Canary['hits'] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      hits.push({ path: new URL(request.url).pathname, referer: request.headers.get('referer') });
      return new Response('<!doctype html><title>Canary</title><p>You left the message.', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  return {
    origin: server.url.origin,
    host: server.url.host,
    hits,
    stop: () => void server.stop(true),
  };
}

/** Launches a browser, or explains how to install it. A missing browser fails, never skips. */
export async function launch(type: BrowserType) {
  try {
    return await type.launch();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      throw new Error(
        `Playwright's ${type.name()} is not installed. Run: bunx playwright install chromium-headless-shell webkit`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Every corpus file in a folder, with the canary standing in for each remote host. */
export async function corpus(folder: 'hostile' | 'real', canary: Canary) {
  const files: { name: string; html: string }[] = [];
  for await (const name of new Bun.Glob('*.html').scan(join(import.meta.dir, 'corpus', folder))) {
    const html = await Bun.file(join(import.meta.dir, 'corpus', folder, name)).text();
    files.push({
      name,
      html: html.replaceAll('{{canary}}', canary.origin).replaceAll('{{canary-host}}', canary.host),
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
