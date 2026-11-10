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

test('a member with no accounts is told who can read their mail, at both sizes in both themes', async () => {
  for (const [size, options] of Object.entries(SIZES)) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const page = await (
        await app.context({ deviceScaleFactor: 2, ...options, colorScheme })
      ).newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      await page.getByRole('heading', { name: 'Welcome to Trail Mix' }).waitFor();
      await page
        .getByText('because the key is theirs. If someone else runs Trail Mix for you', {
          exact: false,
        })
        .waitFor();
      await page.getByRole('form', { name: 'Add an account' }).waitFor();
      await page.screenshot({ path: join(SHOTS, `${size}-${colorScheme}-first-run.png`) });
      const screen = `${size} ${colorScheme} first run`;
      expect({ screen, unreadable: await unreadableText(page) }).toEqual({
        screen,
        unreadable: [],
      });
      await page.close();
    }
  }
}, 60_000);
