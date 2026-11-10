import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright';
import {
  BROWSERS,
  corpus,
  launch,
  serveCanary,
  serveHarness,
  type Call,
  type Canary,
  type Harness,
} from './browsers.ts';
import { bodyKey, newsletter as newsletterFixture } from './harness/fixtures.ts';

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
  const real = await corpus('real', canary);
  newsletter = real.find(({ name }) => name === 'newsletter.html')?.html ?? '';
  harness = await serveHarness(mailroom);
}, 60_000);

afterAll(() => {
  harness.stop();
  canary.stop();
});

const SIZES = { desktop: { width: 900, height: 900 }, phone: { width: 390, height: 844 } };

for (const type of BROWSERS) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    describe(`${type.name()} at ${size} size`, () => {
      let browser: Browser;
      let page: Page;
      beforeAll(async () => {
        browser = await launch(type);
        // A browser's first page starts its processes and compiles the harness. That happens
        // here, so no test's own time pays for it.
        await open('lunch');
        await page.close();
      }, 60_000);
      afterAll(() => browser.close());

      async function open(fixture: 'lunch' | 'newsletter', upcoming: string[] = []) {
        page = await browser.newPage({ viewport });
        harness.parts.length = 0;
        harness.proxied.length = 0;
        canary.hits.length = 0;
        await page.goto(harness.origin);
        await page.evaluate(([name, html, next]) => window.showConversation(name, html, next), [
          fixture,
          fixture === 'lunch' ? '' : newsletter,
          upcoming,
        ] as const);
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

      /** Every key a shortcut could hear: those the page heard and those a message handed on. */
      const heard = () => page.evaluate(() => [...window.pageKeys, ...window.messageKeys]);
      /** The focused element, or the frame whose document holds the focus. */
      const focused = () => page.evaluate(() => document.activeElement?.tagName);
      /** Every element that held the focus over the given time. */
      const focusedOver = (ms: number) =>
        page.evaluate(
          (ms) =>
            new Promise<(string | undefined)[]>((resolve) => {
              const seen = new Set<string | undefined>();
              const look = setInterval(() => seen.add(document.activeElement?.tagName), 20);
              setTimeout(() => {
                clearInterval(look);
                resolve([...seen]);
              }, ms);
            }),
          ms,
        );
      /** The open message's first lines, and what's selected in its frame. */
      const message = () => page.frameLocator('iframe').getByText('Perfect, Thursday it is.');
      const selected = () =>
        page.evaluate(
          () => document.querySelector('iframe')?.contentDocument?.getSelection()?.toString() ?? '',
        );

      // Chromium hands on the keys a message's document hears. WebKit runs no listener at all in a
      // document whose sandbox allows no scripts, so there the page takes the focus back instead.
      test('a key pressed after a click inside a message still reaches the shortcuts', async () => {
        await open('lunch');
        await message().click();
        await page.waitForTimeout(500);
        await page.keyboard.press('e');
        expect(await heard()).toEqual(['e']);
        await page.close();
      });

      test('text selected inside a message keeps the focus there, to copy, until a click lets it go', async () => {
        await open('lunch');
        // A double click on the first word of its first line selects the word.
        await message().dblclick({ position: { x: 12, y: 8 } });
        await page.waitForTimeout(500);
        expect(await selected()).toBe('Perfect');
        expect(await focusedOver(1_000)).toEqual(['IFRAME']);

        // A click on another word, which selects nothing, gives the keys back to the shortcuts.
        await message().click({ position: { x: 120, y: 8 } });
        await page.waitForTimeout(500);
        await page.keyboard.press('e');
        expect(await heard()).toEqual(['e']);
        await page.close();
      });

      // Only WebKit takes the focus back from a message, and in Chromium a Playwright drag over a
      // frame that runs no scripts never finishes.
      test.skipIf(type.name() === 'chromium')(
        'text selected by a drag that began slowly takes the focus back, to copy',
        async () => {
          await open('lunch');
          const line = (await message().boundingBox())!;
          await page.mouse.move(line.x + 1, line.y + 8);
          await page.mouse.down();
          // Long enough for the page to take the focus back before anything is selected.
          await page.waitForTimeout(500);
          await page.mouse.move(line.x + 60, line.y + 8);
          await page.mouse.up();
          await page.waitForTimeout(300);
          expect(await selected()).toStartWith('Perfect');
          expect(await focused()).toBe('IFRAME');
          await page.close();
        },
      );

      test('shows the raw source and headers as text, never as markup', async () => {
        await open('lunch');
        await page.getByRole('button', { name: 'More for this message' }).click();
        await page.getByRole('menuitem', { name: 'View source' }).click();
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

      test('allows a sender’s images from now on, and shows them at once', async () => {
        await open('newsletter');
        harness.calls.length = 0;
        await page.getByRole('button', { name: 'Always show' }).click();
        await until(() => harness.calls.length > 0);
        expect(harness.calls).toEqual([
          { name: 'allowImages', args: ['personal', 'news@trailhead.example.com'] },
        ]);
        await framesFitted(page);
        await page.waitForTimeout(300);
        expect(harness.proxied.map((url) => new URL(url).pathname)).toContain(
          '/newsletter/logo.png',
        );
        await page.close();
      });

      test('fetches the newest body of each conversation that may open next', async () => {
        harness.calls.length = 0;
        await open('lunch', ['trailhead']);
        await until(() => harness.calls.some(({ name }) => name === 'body'));
        expect(harness.calls.map(({ name, args }) => [name, args[0]])).toEqual([
          ['conversation', 'trailhead'],
          ['body', { account: 'personal', path: 'INBOX', uidValidity: 1, uid: 9 }],
        ]);
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

/** The Mailroom's answers for the newsletter, the conversation prepared ahead. */
function mailroom({ name, args }: Call): unknown {
  const fixture = newsletterFixture(newsletter);
  if (name === 'conversation' && args[0] === 'trailhead') return fixture.conversation;
  if (name === 'body') return fixture.bodies[bodyKey(args[0] as Parameters<typeof bodyKey>[0])];
  return null;
}

async function until(condition: () => boolean, timeout = 2_000) {
  for (const start = Date.now(); !condition() && Date.now() - start < timeout;) {
    await Bun.sleep(20);
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
