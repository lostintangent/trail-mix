import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import {
  corpus,
  launch,
  serveCanary,
  serveHarness,
  type Canary,
  type Harness,
} from './browsers.ts';

/**
 * The reader around the frame, on fixture conversations in real browsers, at a desktop's width and
 * a phone's: inline images, attachments, folded quotes and messages, the source view, and images
 * that load only once the member allows them.
 */

let harness: Harness;
let canary: Canary;
let newsletter: string;

beforeAll(async () => {
  canary = serveCanary();
  harness = await serveHarness();
  const real = await corpus('real', canary);
  newsletter = real.find(({ name }) => name === 'newsletter.html')?.html ?? '';
}, 60_000);

afterAll(() => {
  harness.stop();
  canary.stop();
});

const SIZES = { desktop: { width: 900, height: 900 }, phone: { width: 390, height: 844 } };
const BROWSERS: BrowserType[] = [chromium, webkit];

for (const type of BROWSERS) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    describe(`${type.name()} at ${size} size`, () => {
      let browser: Browser;
      let page: Page;
      beforeAll(async () => {
        browser = await launch(type);
      }, 30_000);
      afterAll(() => browser.close());

      async function open(fixture: 'lunch' | 'newsletter') {
        page = await browser.newPage({ viewport });
        harness.parts.length = 0;
        harness.proxied.length = 0;
        canary.hits.length = 0;
        await page.goto(harness.origin);
        await page.evaluate(
          ([name, html]) => window.showConversation(name as 'lunch' | 'newsletter', html ?? ''),
          [fixture, fixture === 'lunch' ? '' : newsletter],
        );
        await framesFitted(page);
      }

      test('shows inline images from the message’s parts, and lists only the other attachments', async () => {
        await open('lunch');
        expect(harness.parts).toContain('/messages/personal/INBOX/1/7/0');
        const attachments = page.getByRole('list', { name: 'Attachments' }).getByRole('link');
        expect(await attachments.count()).toBe(1);
        expect(await attachments.first().textContent()).toContain('Autumn menu.pdf');
        expect(await attachments.first().getAttribute('href')).toBe(
          '/messages/personal/INBOX/1/7/1',
        );
        await page.close();
      });

      test('folds the quote until it is asked for', async () => {
        await open('lunch');
        const frame = page.frameLocator('iframe');
        expect(await frame.getByText('book the table by the window').isVisible()).toBe(false);
        await page.getByRole('button', { name: 'Quoted text' }).click();
        await framesFitted(page);
        await frame.getByText('book the table by the window').waitFor({ state: 'visible' });
        await page.close();
      });

      test('opens an older message from its folded line, with its own quote folded', async () => {
        await open('lunch');
        expect(await page.getByRole('article').count()).toBe(1);
        await page.getByRole('button', { name: /^You/ }).click();
        const sheet = page.getByRole('article', { name: 'Message from Jonas Berg' });
        expect(await sheet.getByText('Thursday works for me.').isVisible()).toBe(true);
        expect(await sheet.getByText('> Ada').count()).toBe(0);
        await sheet.getByRole('button', { name: 'Quoted text' }).click();
        expect(await sheet.getByText('> Ada', { exact: false }).isVisible()).toBe(true);
        await page.close();
      });

      test('shows the raw source and headers as text, never as markup', async () => {
        await open('lunch');
        await page.getByRole('button', { name: 'View source' }).click();
        const dialog = page.getByRole('dialog');
        await dialog
          .getByText('<script>parent.__pwned', { exact: false })
          .waitFor({ state: 'visible' });
        expect(await dialog.getByText('Message-ID').isVisible()).toBe(true);
        expect(await page.evaluate(() => window.pwned)).toEqual([]);
        await page.close();
      });

      test('loads a sender’s images only when asked, and only through the proxy', async () => {
        await open('newsletter');
        expect(harness.proxied).toEqual([]);
        await page.getByRole('button', { name: 'Show', exact: true }).click();
        await framesFitted(page);
        await page.waitForTimeout(300);
        expect(harness.proxied.map((url) => new URL(url).pathname)).toContain(
          '/newsletter/logo.png',
        );
        expect(canary.hits).toEqual([]);
        await page.close();
      });

      test('asks to allow a sender’s images from now on', async () => {
        await open('newsletter');
        await page.getByRole('button', { name: 'Always show' }).click();
        expect(await page.evaluate(() => window.allowed)).toEqual(['news@trailhead.example.com']);
        await page.close();
      });

      test('fits wide mail to the reader’s width', async () => {
        await open('newsletter');
        const overflow = await page.locator('article iframe').evaluate((frame) => {
          const box = frame.parentElement as HTMLElement;
          return box.scrollWidth - box.clientWidth;
        });
        expect(overflow).toBeLessThanOrEqual(1);
        await page.close();
      });
    });
  }
}

async function framesFitted(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('iframe')].every(
      (frame) =>
        frame.style.visibility === 'visible' && frame.contentDocument?.readyState === 'complete',
    ),
  );
}
