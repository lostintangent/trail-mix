import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';

/**
 * The first-run screen, as a member with no accounts sees it: the built app without the demo
 * mailbox, at both sizes in both themes. Adding an account from it is proven against the test mail
 * server, in `tests/accounts`.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

const app = suite({
  vars: { DEMO_MAILBOX: '', DEV_MEMBER: `first-run-${Date.now()}@trailmix.test` },
});
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

test('a member with no accounts is welcomed, never sees the workbench, and finds the sheet in place, at both sizes in both themes', async () => {
  for (const [size, options] of Object.entries(SIZES)) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await app.context({ deviceScaleFactor: 2, ...options, colorScheme });
      // Watched from before the app's first script, so a workbench drawn for a moment counts.
      await context.addInitScript(() => {
        const page = window as unknown as { workbenchSeen: boolean };
        page.workbenchSeen = false;
        new MutationObserver(() => {
          if (document.querySelector('nav[aria-label="Mailboxes"], [role="listbox"]')) {
            page.workbenchSeen = true;
          }
        }).observe(document, { childList: true, subtree: true });
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      const sheet = page.getByRole('article', { name: 'Welcome to Trail Mix' });
      await page.getByRole('form', { name: 'Add an account' }).waitFor();
      await page.screenshot({ path: join(SHOTS, `${size}-${colorScheme}-first-run.png`) });
      const screen = `${size} ${colorScheme} first run`;
      const place = await sheet.evaluate((element, isPhone) => {
        const { top, height } = element.getBoundingClientRect();
        return isPhone
          ? top === 0 && height >= innerHeight
          : Math.abs(top - (innerHeight - height) / 2) <= 1;
      }, size === 'phone');
      expect({
        screen,
        workbench: await page.evaluate(
          () => (window as unknown as { workbenchSeen: boolean }).workbenchSeen,
        ),
        // On a desktop in the desk's middle, and on a phone the whole screen.
        place,
        unreadable: await unreadableText(page),
      }).toEqual({ screen, workbench: false, place: true, unreadable: [] });
      await page.close();
    }
  }
}, 60_000);

test('a Mailroom that can’t be reached says so, and Try again comes back to it', async () => {
  const page = await (await app.context(SIZES.desktop)).newPage();
  // Every query fails, as when the network is down or a sign-in has run out.
  await page.route('**/_serverFn/**', (route) =>
    route.request().method() === 'GET' ? route.abort() : route.fallback(),
  );
  await page.goto(app.url);
  // Once its tries are spent.
  await page
    .getByRole('heading', { name: 'Trail Mix can’t reach your mail' })
    .waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(SHOTS, 'desktop-light-unreachable.png') });
  await page.unroute('**/_serverFn/**');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('heading', { name: 'Welcome to Trail Mix' }).waitFor();
}, 30_000);
