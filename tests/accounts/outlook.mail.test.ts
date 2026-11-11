// Outlook, end to end: the built app on workerd, without the demo mailbox, signing in at the test
// mail server's stand-in for Microsoft. A member picks Outlook, reads a code, and the stand-in plays
// them approving it, declining it, or their sign-in lapsing until they sign in again. Each is done
// at a desktop's size and a phone's, as a member of their own.
import { afterEach, beforeAll, describe, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContextOptions, Locator, Page, Response } from 'playwright';
import { unreadableText } from '../e2e/contrast.ts';
import { atRest } from '../atRest.ts';
import { suite } from '../e2e/suite.ts';
import {
  caFile,
  empty,
  identity,
  importInbox,
  ports,
  start,
  users,
} from '../mail-server/server.ts';

const { alice, bob } = users;
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;
const SHOTS = join(import.meta.dir, '../../test-results');

/** Outlook, as a test reaches it: Microsoft's sign-in at the stand-in, and the test mail server. */
const OUTLOOK = {
  MICROSOFT_CLIENT_ID: 'trail-mix-test',
  OUTLOOK_STAND_IN: JSON.stringify({
    authority: identity.authority,
    imap: { host: 'localhost', port: ports.imaps, secure: true },
    smtp: { host: 'localhost', port: ports.submission, secure: false },
  }),
};

/** Anything shaped like the stand-in's device codes and tokens. */
const SECRET = /[0-9a-f]{32}/;

beforeAll(async () => {
  await start('outlook');
  await empty(alice.email);
  const mbox = join(mkdtempSync(join(tmpdir(), 'outlook-')), 'inbox');
  writeFileSync(
    mbox,
    [
      `From ${bob.email} Tue Nov 10 09:00:00 2026`,
      `From: Bob <${bob.email}>`,
      `To: ${alice.email}`,
      'Subject: The ferry times',
      'Message-ID: <ferry@trailmix.test>',
      `Date: ${new Date().toUTCString()}`,
      '',
      'The last one leaves at six.',
      '',
    ].join('\n'),
  );
  await importInbox(alice.email, mbox);
}, 120_000);

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

/** The stand-in's sign-in page, where a test plays the member. */
async function atMicrosoft(page: Page, as: Record<string, string>) {
  const code = (await codeOf(page).textContent()) ?? '';
  const response = await fetch(`${identity.origin}/devicelogin`, {
    method: 'POST',
    body: new URLSearchParams({ user_code: code.trim(), ...as }),
  });
  expect(response.status).toBe(204);
}

const codeOf = (page: Page) => page.locator('output[aria-label="Code"]');

for (const [size, options] of Object.entries(SIZES)) {
  describe(`Outlook at a ${size}’s size`, () => {
    const app = suite({
      vars: {
        DEMO_MAILBOX: '',
        DEV_MEMBER: `outlook-${size}-${Date.now()}@trailmix.test`,
        ...OUTLOOK,
      },
      env: { NODE_EXTRA_CA_CERTS: caFile },
    });
    const { test } = app;

    async function open(more: BrowserContextOptions = {}): Promise<Page> {
      const page = await (
        await app.context({ deviceScaleFactor: 2, ...options, ...more })
      ).newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      return page;
    }

    /** Picks Outlook and asks Microsoft for a code, as a member would. */
    async function startSigningIn(page: Page) {
      await page.getByRole('radio', { name: 'Outlook' }).click();
      await page.getByRole('textbox', { name: 'Address' }).fill(alice.email);
      expect(await page.getByLabel('Password', { exact: true }).count()).toBe(0);
      await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
      await codeOf(page).waitFor();
    }

    const ferry = (page: Page) => page.getByRole('option').filter({ hasText: 'The ferry times' });

    test('a declined sign-in says why, and a new code starts again', async () => {
      const page = await open({ colorScheme: 'light' });
      await page.getByRole('heading', { name: 'Welcome to Trail Mix' }).waitFor();
      await startSigningIn(page);
      const first = await codeOf(page).textContent();
      await atMicrosoft(page, { decline: '1' });
      const refusal = page.getByRole('alert').filter({ hasText: 'The sign-in didn’t finish.' });
      await refusal
        .getByText('You declined the sign-in at Microsoft.')
        .waitFor({ timeout: 15_000 });
      await readable(page, size, 'declined');

      await page.getByRole('button', { name: 'Get a new code' }).click();
      await page.waitForFunction(
        (before) => document.querySelector('output[aria-label="Code"]')?.textContent !== before,
        first,
      );
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Sign in with Microsoft' }).waitFor();
    }, 60_000);

    test('an Outlook account signs in with a code, and the browser never holds a token', async () => {
      const page = await open();
      const answered: Promise<string>[] = [];
      page.on('response', (response: Response) => {
        if (response.url().includes('/_serverFn/')) answered.push(response.text().catch(() => ''));
      });
      await startSigningIn(page);
      const step = page.getByRole('region', { name: 'Signing in at Microsoft' });
      await step.getByText(`sign in as ${alice.email}`, { exact: false }).waitFor();
      await step.getByText('The code expires in 1', { exact: false }).waitFor();
      const link = step.getByRole('link', { name: 'Open 127.0.0.1' });
      expect(await link.getAttribute('href')).toBe(`${identity.origin}/devicelogin`);
      expect(await link.getAttribute('target')).toBe('_blank');
      if (size === 'phone') expect(await smallTargets(step)).toEqual([]);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await readable(page, size, `${scheme}-code`);
      }

      // Tokens that last two seconds have every connection refresh, which a later test leans on.
      await atMicrosoft(page, { login_hint: alice.email, expires_in: '2' });
      await ferry(page).waitFor({ timeout: 30_000 });
      const bodies = await Promise.all(answered);
      expect(bodies.filter((body) => SECRET.test(body))).toEqual([]);
      expect(
        await page.evaluate(() =>
          [
            location.href,
            JSON.stringify({ ...localStorage }),
            JSON.stringify({ ...sessionStorage }),
          ].join(' '),
        ),
      ).not.toMatch(SECRET);
    }, 60_000);

    test('an account whose sign-in lapsed says so on its line and its stamp, and signs in again from its menu', async () => {
      await fetch(`${identity.origin}/revoke`, {
        method: 'POST',
        body: new URLSearchParams({ login_hint: alice.email }),
      });
      // Opening Trail Mix checks the account, whose refresh Microsoft now refuses.
      const page = await open({ colorScheme: 'dark' });
      await ferry(page).waitFor({ timeout: 30_000 });
      if (size === 'phone')
        await page.getByRole('button', { name: 'Folders', exact: true }).click();
      const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
      await sidebar
        .getByRole('button', { name: /^trailmix\.test Sign in again/i })
        .waitFor({ timeout: 30_000 });
      await readable(page, size, 'dark-lapsed');
      if (size === 'desktop') {
        // Folded, its stamp says so too.
        await page.keyboard.press('ControlOrMeta+b');
        await sidebar.getByRole('button', { name: /^trailmix\.test, Sign in again/ }).waitFor();
        // The fold swaps the sidebar's lines for the rail's, ending their transitions early.
        await atRest(page);
        await readable(page, size, 'dark-lapsed-rail');
        await page.keyboard.press('ControlOrMeta+b');
      }
      // Its menu offers the fix.
      await sidebar.getByRole('button', { name: 'More for trailmix.test' }).click();
      await page.getByRole('menuitem', { name: 'Sign in to trailmix.test again' }).click();

      const again = page.getByRole('region', { name: 'Signing in at Microsoft' });
      await codeOf(page).waitFor();
      await readable(page, size, 'dark-again');
      await atMicrosoft(page, { login_hint: alice.email });
      await again.waitFor({ state: 'detached', timeout: 30_000 });
      await sidebar
        .getByRole('button', { name: /Sign in again/ })
        .waitFor({ state: 'detached', timeout: 30_000 });
      await ferry(page).waitFor();
    }, 90_000);
  });
}

describe('Outlook, before the operator has registered Trail Mix with Microsoft', () => {
  const app = suite({
    vars: { DEMO_MAILBOX: '', DEV_MEMBER: `outlook-unset-${Date.now()}@trailmix.test` },
    env: { NODE_EXTRA_CA_CERTS: caFile },
  });

  app.test(
    'the Outlook choice says so, and can’t be pressed',
    async () => {
      const page = await (await app.context({ viewport: { width: 1440, height: 900 } })).newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      await page.getByRole('radio', { name: 'Outlook' }).click();
      await page
        .getByText(
          'Microsoft sign-in isn’t set up on this Trail Mix. The operator registers an app with Microsoft and sets MICROSOFT_CLIENT_ID.',
        )
        .waitFor();
      expect(await page.getByRole('button', { name: 'Sign in with Microsoft' }).isDisabled()).toBe(
        true,
      );
    },
    60_000,
  );
});

/** The controls in a region that a finger can't be sure to hit, by name. */
function smallTargets(within: Locator): Promise<string[]> {
  return within.locator('a, input, button').evaluateAll((controls) =>
    controls.flatMap((control) => {
      const box = control.getBoundingClientRect();
      if (box.height === 0) return [];
      return box.height < 44 || box.width < 44
        ? [control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName]
        : [];
    }),
  );
}

async function readable(page: Page, size: string, screen: string) {
  // A theme changes over 125 ms, and a screen read mid-change has colors from both.
  await atRest(page);
  await page.screenshot({ path: join(SHOTS, `outlook-${size}-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}
