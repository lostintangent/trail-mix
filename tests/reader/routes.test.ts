import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import type { MessageRef } from '../../src/features/mail/core/index.ts';
import { MAX_IMAGE_BYTES, proxyImage } from '../../src/server/routes/images.ts';
import { serveMessageBytes, type MessageBytes } from '../../src/server/routes/messages.ts';
import { launch } from './browsers.ts';

/**
 * The routes that serve a message's bytes and remote images share Trail Mix's origin and the
 * member's sign-in, so a sender's bytes opened directly must never run. Each case is opened in a
 * real browser, and any script that ran would tell the remote server.
 */

/** A real 1x1 PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);

let remote: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof Bun.serve>;
const ran: string[] = [];

/** Markup that reports to the remote server if anything in it runs or loads. */
const hostile = (id: string) =>
  `<!doctype html><title>x</title><script>fetch('${remote.url.origin}/ran?${id}')</script><img src="${remote.url.origin}/ran?${id}-img"><p>${id}</p>`;

const REF: MessageRef = { account: 'personal', path: 'INBOX', uidValidity: 1, uid: 7 };

/** The Mailroom's bytes for one hostile message. */
const MAILROOM: MessageBytes = {
  source: () =>
    Promise.resolve(stream(`Subject: Hi\r\nContent-Type: text/html\r\n\r\n${hostile('source')}`)),
  part: (_ref, id) =>
    Promise.resolve(PARTS[id] ? { ...PARTS[id], body: stream(PARTS[id].bytes) } : null),
};

let PARTS: Record<string, { type: string; name: string; bytes: string | Uint8Array<ArrayBuffer> }>;

beforeAll(() => {
  remote = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/ran') {
        ran.push(url.search);
        return new Response('');
      }
      const reply = REMOTE[url.pathname];
      return reply ? reply() : new Response('', { status: 404 });
    },
  });
  PARTS = {
    html: { type: 'text/html', name: 'invite.html', bytes: hostile('html-part') },
    svg: {
      type: 'image/svg+xml',
      name: 'logo.svg',
      bytes: `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('${remote.url.origin}/ran?svg-part')</script></svg>`,
    },
    disguised: { type: 'image/png', name: 'photo.png', bytes: hostile('disguised-part') },
    photo: { type: 'image/png; name="photo.png"', name: 'photo.png', bytes: PNG },
    injected: {
      type: 'text/html\r\nSet-Cookie: stolen=1',
      name: 'evil"\r\nSet-Cookie: stolen=1.html',
      bytes: hostile('injected-part'),
    },
  };
  app = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/images') return proxyImage(request, internet);
      const [, , attachmentId] = url.pathname.split('/');
      return serveMessageBytes({ ref: REF, attachmentId }, MAILROOM);
    },
  });
});

afterAll(() => {
  void remote.stop(true);
  void app.stop(true);
});

/** What the remote image host answers. */
const REMOTE: Record<string, () => Response> = {
  '/photo.png': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
  '/page.html': () =>
    new Response(hostile('remote-html'), { headers: { 'content-type': 'text/html' } }),
  '/logo.svg': () =>
    new Response(PARTS.svg?.bytes, { headers: { 'content-type': 'image/svg+xml' } }),
  '/disguised.png': () =>
    new Response(hostile('remote-disguised'), { headers: { 'content-type': 'image/png' } }),
  '/huge.png': () =>
    new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { 'content-type': 'image/png' } }),
  // No length up front, and more bytes than the limit.
  '/endless.png': () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
      { headers: { 'content-type': 'image/png' } },
    ),
  '/to-this-machine': () =>
    new Response(null, { status: 302, headers: { location: `${remote.url.origin}/photo.png` } }),
  '/to-a-photo': () =>
    new Response(null, {
      status: 302,
      headers: { location: 'http://images.example.com/photo.png' },
    }),
};

/** The internet, as the proxy sees it: `images.example.com` is the remote image host. */
const internet: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    return fetch(url.replace('http://images.example.com', remote.url.origin), init);
  },
  { preconnect: fetch.preconnect },
);

const proxied = (url: string) => fetch(`${app.url.origin}/images?url=${encodeURIComponent(url)}`);

describe('the image proxy', () => {
  test('serves a remote raster image under the byte headers', async () => {
    const response = await proxied('http://images.example.com/photo.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-security-policy')).toStartWith('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  test('refuses anything that is not a raster image, SVG included', async () => {
    expect((await proxied('http://images.example.com/page.html')).status).toBe(415);
    expect((await proxied('http://images.example.com/logo.svg')).status).toBe(415);
  });

  test('refuses an image over the size limit, even one that never says its size', async () => {
    expect((await proxied('http://images.example.com/huge.png')).status).toBe(413);
    const endless = await proxyImage(
      new Request(`${app.url.origin}/images?url=http://images.example.com/endless.png`),
      internet,
    );
    await expect(endless.arrayBuffer()).rejects.toThrow('too large');
  });

  test('refuses addresses that are not on the public internet, or carry credentials', async () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'http://localhost/photo.png',
      'http://127.0.0.1/photo.png',
      'http://0x7f.1/photo.png',
      'http://10.0.0.8/photo.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/photo.png',
      'http://printer.local/photo.png',
      'http://user:secret@images.example.com/photo.png',
    ]) {
      expect((await proxied(url)).status).toBe(400);
    }
  });

  test('checks every redirect as it checks the first address', async () => {
    expect((await proxied('http://images.example.com/to-this-machine')).status).toBe(400);
    expect((await proxied('http://images.example.com/to-a-photo')).status).toBe(200);
  });
});

describe('a part’s headers', () => {
  test('keep a sender’s type and name from adding headers of their own', async () => {
    const response = await fetch(`${app.url.origin}/messages/injected`);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toStartWith('attachment;');
  });

  test('show a raster image inline and download everything else', async () => {
    const disposition = async (id: string) =>
      (await fetch(`${app.url.origin}/messages/${id}`)).headers.get('content-disposition');
    expect(await disposition('photo')).toStartWith('inline;');
    for (const id of ['html', 'svg']) expect(await disposition(id)).toStartWith('attachment;');
  });
});

const BROWSERS: BrowserType[] = [chromium, webkit];

for (const type of BROWSERS) {
  describe(`${type.name()}, opening each route directly`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await launch(type);
    }, 30_000);
    afterAll(() => browser.close());

    test('runs nothing, whatever the sender’s bytes say they are', async () => {
      ran.length = 0;
      const context = await browser.newContext({ acceptDownloads: true });
      for (const path of [
        '/messages',
        '/messages/html',
        '/messages/svg',
        '/messages/disguised',
        '/messages/injected',
        `/images?url=${encodeURIComponent('http://images.example.com/disguised.png')}`,
      ]) {
        const page = await context.newPage();
        // A download aborts the navigation, which is what should happen to a document part.
        await page.goto(`${app.url.origin}${path}`).catch(() => {});
        await page.waitForTimeout(300);
        await page.close();
      }
      await context.close();
      expect(ran).toEqual([]);
    }, 30_000);

    test('shows the raw source as text', async () => {
      const page = await browser.newPage();
      await page.goto(`${app.url.origin}/messages`);
      expect(await page.locator('body').textContent()).toContain('<script>fetch(');
      await page.close();
    });
  });
}

function stream(bytes: string | Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> {
  return new Response(bytes).body ?? new ReadableStream();
}
