import { afterEach, beforeAll, describe, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';
import { atRest } from '../atRest.ts';

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

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

// Each describe runs its own app, which stops before the next one starts: a preview's variables
// and its build's pointer are one file each, so two at once would read each other's.
describe('The first-run screen', () => {
  const app = suite({
    vars: { DEMO_MAILBOX: '', DEV_MEMBER: `first-run-${Date.now()}@trailmix.test` },
  });
  // A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
  const { test } = app;

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
    const asked: number[] = [];
    await page.route('**/_serverFn/**', (route) => {
      if (route.request().url().includes('%22accounts%22')) asked.push(Date.now());
      return route.request().method() === 'GET' ? route.abort() : route.fallback();
    });
    await page.goto(app.url);
    // Once its tries are spent: the browser says it's online, so the request it lost is asked
    // again, three times over seven seconds.
    await page
      .getByRole('heading', { name: 'Trail Mix can’t reach your mail' })
      .waitFor({ timeout: 15_000 });
    const waited = (asked.at(-1) ?? 0) - (asked[0] ?? 0);
    expect({ asks: asked.length, isSpread: waited > 5_000 }).toEqual({ asks: 4, isSpread: true });
    // Online, the browser's own words are the only clue to what went wrong.
    await page.getByText('No answer came: Failed to fetch', { exact: true }).waitFor();
    await page.screenshot({ path: join(SHOTS, 'desktop-light-unreachable.png') });
    await page.unroute('**/_serverFn/**');
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('heading', { name: 'Welcome to Trail Mix' }).waitFor();
  }, 30_000);

  test('a Mailroom that answered with an error says what failed, and comes back once the tab is seen', async () => {
    const page = await (await app.context(SIZES.desktop)).newPage();
    // Every query is answered with an error, as when a deploy restarts the Mailroom.
    await page.route('**/_serverFn/**', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 503,
            contentType: 'text/plain',
            body: 'The Mailroom is restarting.',
          })
        : route.fallback(),
    );
    await page.goto(app.url);
    await page
      .getByRole('heading', { name: 'Trail Mix can’t reach your mail' })
      .waitFor({ timeout: 15_000 });
    await page.getByText('Trail Mix answered 503: The Mailroom is restarting.').waitFor();
    await page.unroute('**/_serverFn/**');
    // Coming back to the tab asks again, with no button pressed.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('heading', { name: 'Welcome to Trail Mix' }).waitFor();
  }, 30_000);
});

// Erasing everything Trail Mix holds for a member, from the palette and from an account's page, on
// two devices at once: each a member of their own, with the demo mailbox to erase.
for (const [size, options] of Object.entries(SIZES)) {
  describe(`Erasing everything at a ${size}’s size`, () => {
    const erasing = suite({
      vars: { DEMO_MAILBOX: '200', DEV_MEMBER: `erase-${size}-${Date.now()}@trailmix.test` },
    });
    const colorScheme = size === 'desktop' ? 'light' : 'dark';

    async function device(more: BrowserContextOptions = {}): Promise<Page> {
      const page = await (await erasing.context({ ...options, colorScheme, ...more })).newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(erasing.url);
      await mailIsIn(page);
      return page;
    }

    async function run(page: Page, title: RegExp) {
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.type(title.source.replace(/^\^/, ''));
      await page.getByRole('option', { name: title }).click();
    }

    erasing.test(
      'a member erases everything after saying what goes, and every device starts over',
      async () => {
        const page = await device();
        const other = await device();
        const question = page.getByRole('alertdialog', {
          name: 'Erase everything Trail Mix holds for you?',
        });

        // From the palette: it says what goes and what stays, and Cancel, which has the focus, keeps it.
        await run(page, /^Erase everything/);
        await question.waitFor();
        expect(await question.textContent()).toContain(
          'The demo mailbox goes, with all its mail. Every device you’re signed in on starts over.',
        );
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Cancel');
        await shown(page, `${size}-${colorScheme}-erase-question`);
        await page.keyboard.press('Enter');
        await question.waitFor({ state: 'detached' });
        expect(await page.getByRole('form', { name: 'Add an account' }).count()).toBe(0);

        // From an account's page, apart from the account, as all of Trail Mix.
        await run(page, /^Edit the Personal account/);
        const everything = page.getByRole('region', { name: 'All of Trail Mix' });
        const erase = everything.getByRole('button', { name: 'Erase everything…' });
        await erase.waitFor();
        if (size === 'phone')
          expect((await erase.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await shown(page, `${size}-${colorScheme}-erase-from-account`);
        await erase.click();
        await question.getByRole('button', { name: 'Erase everything' }).click();

        // Both devices start over, and so does a fresh sign-in.
        await page.getByRole('form', { name: 'Add an account' }).waitFor();
        await other.getByRole('form', { name: 'Add an account' }).waitFor({ timeout: 30_000 });
        await page.reload();
        await page.getByRole('form', { name: 'Add an account' }).waitFor();
        await shown(page, `${size}-${colorScheme}-erased`);
      },
      90_000,
    );
  });
}

async function shown(page: Page, screen: string) {
  await atRest(page);
  await page.screenshot({ path: join(SHOTS, `accounts-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}
