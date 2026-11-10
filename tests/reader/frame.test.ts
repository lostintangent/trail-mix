import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright';
import {
  BROWSERS,
  corpus,
  launch,
  serveCanary,
  serveHarness,
  type Canary,
  type Harness,
} from './browsers.ts';
import type { Result, Shown } from './harness/main.tsx';

/**
 * Hostile and real-world mail, rendered in the reader's real frame in real browsers: Chromium for
 * desktops and WebKit for iPhones. A canary on another origin stands in for every remote host, and
 * hostile mail calls `parent.__pwned` if any of its script ever runs, so each test observes what
 * the frame did rather than reading the sanitizer's configuration.
 */

let harness: Harness;
let canary: Canary;
let hostile: { name: string; html: string }[];
let real: { name: string; html: string }[];

beforeAll(async () => {
  canary = serveCanary();
  harness = await serveHarness();
  [hostile, real] = await Promise.all([corpus('hostile', canary), corpus('real', canary)]);
}, 60_000);

afterAll(() => {
  harness.stop();
  canary.stop();
});

for (const type of BROWSERS) {
  describe(type.name(), () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await launch(type);
    }, 30_000);
    afterAll(() => browser.close());

    describe('hostile mail, before its sender is allowed', () => {
      let seen: Observation;
      beforeAll(async () => {
        seen = await observe(
          browser,
          hostile.map(({ html }) => ({ html, images: 'blocked' })),
        );
      }, 30_000);

      test('runs no script', () => {
        expect(seen.pwned).toEqual([]);
        expect(seen.dialogs).toEqual([]);
      });

      test('submits no form and loads nothing, even when every control is clicked', () => {
        expect(seen.canary).toEqual([]);
        expect(seen.elsewhere).toEqual([]);
        expect(seen.proxied).toEqual([]);
      });

      test('says that it left images out', () => {
        const images = hostile.findIndex(({ name }) => name === 'images.html');
        expect(seen.results[images]?.blockedImages).toBe(true);
      });
    });

    describe('hostile mail, once its sender is allowed', () => {
      let seen: Observation;
      beforeAll(async () => {
        seen = await observe(
          browser,
          hostile.map(({ html }) => ({ html, images: 'allowed' })),
        );
      }, 30_000);

      test('still runs no script', () => {
        expect(seen.pwned).toEqual([]);
        expect(seen.dialogs).toEqual([]);
      });

      test('loads images only through the proxy, and nothing else at all', () => {
        expect(seen.canary).toEqual([]);
        expect(seen.elsewhere).toEqual([]);
        const proxied = seen.proxied.map((url) => new URL(url).pathname);
        for (const path of ['/img.png', '/protocol-relative.png', '/body-background.png']) {
          expect(proxied).toContain(path);
        }
        for (const path of ['/table-background.png', '/td-background.png', '/srcset-1x.png']) {
          expect(proxied).toContain(path);
        }
        expect(proxied.some((path) => /^\/(srcset|picture-source)/.test(path))).toBe(true);
        // Fonts, stylesheets, scripts and media never load, not even through the proxy.
        expect(
          proxied.filter((path) => /\.(css|woff2?|js|mp4|mp3|vtt|htc|xml)$/.test(path)),
        ).toEqual([]);
      });

      test('loads every lazy image at once, so scrolling reports nothing', () => {
        expect(seen.proxied.map((url) => new URL(url).pathname)).toContain('/lazy.png');
      });
    });

    // Each wall holds alone, so a flaw in one is never enough.
    describe('hostile mail, with the sanitizer skipped', () => {
      let seen: Observation;
      beforeAll(async () => {
        seen = await observe(
          browser,
          hostile.map(({ html }) => ({ html, images: 'blocked', walls: 'frame' })),
        );
      }, 30_000);

      test('the frame alone still runs no script', () => {
        expect(seen.pwned).toEqual([]);
        expect(seen.dialogs).toEqual([]);
      });

      test('the frame alone still submits no form and loads no resource', () => {
        expect(seen.canary).toEqual([]);
        expect(seen.elsewhere).toEqual([]);
      });
    });

    describe('hostile mail, sanitized into an open frame', () => {
      let seen: Observation;
      beforeAll(async () => {
        seen = await observe(
          browser,
          hostile.map(({ html }) => ({ html, images: 'blocked', walls: 'sanitizer' })),
        );
      }, 30_000);

      test('the sanitizer alone leaves no script to run', () => {
        expect(seen.pwned).toEqual([]);
        expect(seen.dialogs).toEqual([]);
      });

      test('the sanitizer alone leaves nothing to load or submit', () => {
        expect(seen.canary).toEqual([]);
        expect(seen.elsewhere).toEqual([]);
        expect(seen.proxied).toEqual([]);
      });
    });

    describe('links', () => {
      test('open in a new tab, with no opener, referrer or ping', async () => {
        const links = hostile.find(({ name }) => name === 'links.html')?.html ?? '';
        const page = await browser.newPage();
        await show(page, [{ html: links, images: 'blocked' }]);
        const frame = page.frames()[1];
        for (const id of ['ping', 'top', 'opener']) {
          const [popup] = await Promise.all([
            page.waitForEvent('popup'),
            frame?.locator(`#${id}`).click(),
          ]);
          await popup.waitForLoadState();
          expect(await popup.evaluate(() => window.opener === null)).toBe(true);
          await popup.close();
        }
        expect(page.url()).toStartWith(harness.origin);
        expect(canary.hits).toEqual(
          ['/link', '/top', '/opener'].map((path) => ({ path, referer: null })),
        );
        await page.close();
      });
    });

    describe('the frame', () => {
      test('keeps the message’s styles inside it', async () => {
        const leaks = hostile.find(({ name }) => name === 'style-leaks.html')?.html ?? '';
        const page = await browser.newPage();
        await page.goto(harness.origin);
        await page.evaluate(() => {
          const marker = document.createElement('p');
          marker.id = 'outside';
          marker.textContent = 'Outside the message';
          document.body.insertBefore(marker, document.body.firstChild);
        });
        await show(page, [{ html: leaks, images: 'blocked' }], false);
        expect(await page.locator('#outside').isVisible()).toBe(true);
        expect(await page.locator('#outside').evaluate((p) => getComputedStyle(p).color)).not.toBe(
          'rgb(255, 0, 0)',
        );
        const box = await page.locator('#outside').boundingBox();
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
          x: (box?.x ?? 0) + 2,
          y: (box?.y ?? 0) + 2,
        });
        expect(hit).toBe('outside');
        await page.close();
      });

      test('stops growing when the message is sized by the frame itself', async () => {
        const tall = hostile.find(({ name }) => name === 'frame-height.html')?.html ?? '';
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await show(page, [{ html: tall, images: 'blocked' }]);
        await page.waitForTimeout(500);
        const height = await page
          .locator('iframe')
          .evaluate((frame: HTMLIFrameElement) => frame.offsetHeight);
        expect(height).toBeLessThanOrEqual(600 * 3);
        await page.close();
      });
    });

    describe('real-world mail', () => {
      let seen: Observation;
      let page: Page;
      beforeAll(async () => {
        page = await browser.newPage({ viewport: { width: 900, height: 900 } });
        seen = await observe(
          browser,
          real.map(({ name, html }): Shown => ({
            html,
            images: 'blocked',
            parts: name === 'receipt.html' ? { 'logo@shop.example.com': RECEIPT_LOGO } : {},
          })),
          page,
        );
      }, 30_000);
      afterAll(() => page.close());

      test('loads nothing remote before its sender is allowed', () => {
        expect(seen.canary).toEqual([]);
        expect(seen.elsewhere).toEqual([]);
        expect(seen.proxied).toEqual([]);
      });

      test('shows inline images from the message’s own parts', () => {
        expect(seen.parts).toEqual([RECEIPT_LOGO]);
        const receipt = real.findIndex(({ name }) => name === 'receipt.html');
        expect(seen.results[receipt]?.inlineParts).toEqual(['logo@shop.example.com']);
      });

      for (const [name, expected] of Object.entries(REAL)) {
        test(`${name}: ${expected.quoted ? 'folds its quote' : 'folds nothing'}`, async () => {
          const index = real.findIndex((mail) => mail.name === name);
          const frame = page.frameLocator(`[data-mail="${index}"] iframe`);
          expect(await frame.getByText(expected.reply).first().isVisible()).toBe(true);
          if (expected.quoted) {
            expect(await frame.getByText(expected.quoted).first().isVisible()).toBe(false);
          }
          expect(seen.results[index]?.quote).toBe(Boolean(expected.quoted));
        });

        test(`${name}: ${expected.ownColors ? 'stays on light paper' : 'follows the theme'}`, () => {
          const index = real.findIndex((mail) => mail.name === name);
          expect(seen.results[index]?.ownColors).toBe(expected.ownColors);
        });
      }
    });
  });
}

/** Where the receipt's inline logo is served, as one of its parts. */
const RECEIPT_LOGO = '/messages/demo/INBOX/1/7/2';

/** What each real-world message shows, hides behind its quote fold, and how it is colored. */
const REAL: Record<string, { reply: string; quoted?: string; ownColors: boolean }> = {
  'apple-mail-reply.html': {
    reply: 'See you at the trailhead',
    quoted: 'Shall we hike on Saturday',
    ownColors: false,
  },
  'forward.html': { reply: 'Park at the north lot', ownColors: false },
  'gmail-reply.html': {
    reply: 'Thursday works for me',
    quoted: 'Are you free for lunch',
    ownColors: false,
  },
  'inline-reply.html': { reply: 'Should I bring the projector', ownColors: false },
  'newsletter.html': { reply: 'The north ridge loop', ownColors: true },
  'notification.html': { reply: 'Should two-digit years', ownColors: false },
  'outlook-desktop-reply.html': {
    reply: 'Approved. Please go ahead',
    quoted: 'Can you approve purchase order',
    ownColors: true,
  },
  'outlook-web-reply.html': {
    reply: 'The quarterly numbers are attached',
    quoted: 'Could you send over the quarterly numbers',
    ownColors: true,
  },
  'plain-html.html': { reply: 'The cabin is booked', ownColors: false },
  'receipt.html': { reply: 'Trail runners, size 42', ownColors: true },
  'thunderbird-reply.html': {
    reply: 'The patch looks right',
    quoted: 'Here is the patch',
    ownColors: false,
  },
  'zoho-reply.html': {
    reply: 'The invoice is paid',
    quoted: 'Invoice 2026-114 is due',
    ownColors: false,
  },
};

type Observation = {
  results: Result[];
  /** Calls hostile script made, and dialogs it opened. */
  pwned: string[];
  dialogs: string[];
  /** Paths requested from the canary, which stands in for every remote host. */
  canary: string[];
  /** Network requests to any origin other than the harness and the canary. */
  elsewhere: string[];
  proxied: string[];
  parts: string[];
};

/** Shows messages, then pokes at them as a reader might, and records everything they caused. */
async function observe(browser: Browser, mails: Shown[], page?: Page): Promise<Observation> {
  const own = page ?? (await browser.newPage());
  const elsewhere: string[] = [];
  const dialogs: string[] = [];
  own.on('request', (request) => {
    // Only a request that reaches the network can tell anyone anything.
    const url = request.url();
    const network = /^(https?|wss?|ftp):/i.test(url);
    if (network && !url.startsWith(harness.origin) && !url.startsWith(canary.origin)) {
      elsewhere.push(url);
    }
  });
  own.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  own.on('popup', (popup) => void popup.close());

  const results = await show(own, mails);
  await poke(own);
  // Long enough for a one-second refresh, an animation and any late load.
  await own.waitForTimeout(1_500);

  const observation = {
    results,
    pwned: await own.evaluate(() => window.pwned),
    dialogs,
    canary: canary.hits.map(({ path }) => path),
    elsewhere,
    proxied: [...harness.proxied],
    parts: [...harness.parts],
  };
  if (!page) await own.close();
  return observation;
}

/** Shows messages in the harness and waits until every frame is sized. */
async function show(page: Page, mails: Shown[], navigate = true): Promise<Result[]> {
  canary.hits.length = 0;
  harness.proxied.length = 0;
  harness.parts.length = 0;
  if (navigate) await page.goto(harness.origin);
  const results = await page.evaluate((shown) => window.show(shown), mails);
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll('iframe')].filter(
        (frame) => frame.style.visibility === 'visible',
      ).length === count,
    mails.length,
  );
  return results;
}

/**
 * Scrolls through every message, hovers over it, and clicks every control that could submit a
 * form or follow a scripted link. Links to remote pages are left alone: following one is the
 * reader's choice, which the links test covers.
 */
async function poke(page: Page) {
  const messages = page.frames().filter((frame) => frame.parentFrame() === page.mainFrame());
  for (const frame of messages) {
    const element = await frame.frameElement();
    await element.scrollIntoViewIfNeeded({ timeout: 1_000 });
    const box = await element.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 50));
    const controls = frame.locator(
      'button, input[type=submit], input[type=image], [href^="javascript" i], [href^=" javascript" i], [href^="java"], [href^="data:"], [href^="vbscript"], #svg-link, #js-area',
    );
    for (const control of await controls.all()) {
      await control.click({ force: true, timeout: 1_000, noWaitAfter: true }).catch(() => {});
    }
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}
