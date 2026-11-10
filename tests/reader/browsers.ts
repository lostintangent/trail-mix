import stylex from '@stylexjs/unplugin/vite';
import react from '@vitejs/plugin-react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit, type BrowserType } from 'playwright';
import { Features } from 'lightningcss';
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
  /** The queries and commands the page sent its Mailroom. */
  calls: Call[];
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

/** A small green image: what the proxy and the parts answer with, visible in screenshots. */
const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGPImlOBFTFQTwIAUqsvwYe2h+gAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);

/** What the harness serves as any message's raw source: headers, and markup that must stay text. */
export const SOURCE = [
  'From: Ada Park <ada@example.com>',
  'Subject: Re: Lunch on Thursday?',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Perfect.</p><script>parent.__pwned("source")</script><img src=x onerror=parent.__pwned("source-img")>',
].join('\r\n');

/** A query or command the page sent its Mailroom. */
export type Call = { name: string; args: unknown[] };

/**
 * Builds the harness and serves it. `answer` plays the Mailroom for the page's queries and
 * commands, which otherwise get nothing back.
 */
export async function serveHarness(answer: (call: Call) => unknown = () => null): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'trail-mix-reader-'));
  await build({
    root: join(import.meta.dir, 'harness'),
    configFile: false,
    logLevel: 'silent',
    plugins: [stylex(stylexOptions), react()],
    resolve: {
      alias: [
        {
          find: /^@tanstack\/react-start$/,
          replacement: join(import.meta.dir, 'harness/start.ts'),
        },
      ],
    },
    build: { outDir: dir, emptyOutDir: true },
    css: { lightningcss: { exclude: Features.LightDark } },
  });
  const proxied: string[] = [];
  const parts: string[] = [];
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/_serverFn') {
        const call = await request.json<Call>();
        calls.push(call);
        return Response.json(answer(call) ?? null);
      }
      if (url.pathname === '/images') {
        proxied.push(url.searchParams.get('url') ?? '');
        return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
      }
      if (url.pathname.startsWith('/messages/')) {
        parts.push(url.pathname);
        // `/messages/<account>/<path>/<uidValidity>/<uid>` is the raw message, and a part adds one more.
        const source = url.pathname.split('/').length === 6;
        return source
          ? new Response(SOURCE, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
          : new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
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
    calls,
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

/**
 * The browsers the reader's tests run in: Chromium for desktops and WebKit for iPhones, both unless
 * `READER_BROWSERS` names some. CI runs each in its own job, because WebKit's system libraries
 * take minutes to install on Linux.
 */
export const BROWSERS: BrowserType[] = (process.env['READER_BROWSERS'] ?? 'chromium,webkit')
  .split(',')
  .map((name) => {
    const type = { chromium, webkit }[name.trim()];
    if (!type) throw new Error(`READER_BROWSERS names "${name}", which is not chromium or webkit.`);
    return type;
  });

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
