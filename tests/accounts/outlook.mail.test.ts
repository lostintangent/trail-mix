// Outlook, end to end: the built app on workerd, without the demo mailbox, signing in at the test
// mail server's stand-in for Microsoft. A member picks Outlook, reads a code, and the stand-in plays
// them approving it, declining it, or their sign-in lapsing until they sign in again. Each is done
// at a desktop's size and a phone's, as a member of their own.
import { beforeAll, describe, expect } from 'bun:test';
import type { BrowserContextOptions, Page, Response } from 'playwright';
import { expectUsable } from '../e2e/usable.ts';
import { SIZES, suite } from '../e2e/suite.ts';
import { caFile, deliver, empty, identity, ports, start, users } from '../mail-server/server.ts';
import { atSignInPage } from '../mail-server/sign-in.ts';
import { message } from '../message.ts';

const { alice, bob } = users;

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
  await deliver(
    alice.email,
    message({
      id: 'ferry',
      from: `Bob <${bob.email}>`,
      to: alice.email,
      subject: 'The ferry times',
      text: 'The last one leaves at six.',
    }),
  );
}, 120_000);

/** The stand-in's sign-in page, where a test plays the member. */
const atMicrosoft = async (page: Page, as: Record<string, string>) =>
  atSignInPage(identity.origin, ((await codeOf(page).textContent()) ?? '').trim(), as);

const codeOf = (page: Page) => page.locator('output[aria-label="Code"]');
const welcome = (page: Page) => page.getByRole('heading', { name: 'Welcome to Trail Mix' });

for (const [size, options] of Object.entries(SIZES)) {
  describe(`Outlook at a ${size}’s size`, () => {
    const app = suite({
      vars: {
        DEMO_MAILBOX: '',
        DEV_MEMBER: `outlook-${size}-${Date.now()}@trailmix.test`,
        ...OUTLOOK,
      },
      env: { NODE_EXTRA_CA_CERTS: caFile },
      scale: 2,
    });
    const { test } = app;

    /** Trail Mix at this size, once it shows its first-run screen or Alice's mail. */
    const open = (more: BrowserContextOptions = {}) =>
      app.open(
        { ...options, ...more },
        { ready: (page) => welcome(page).or(ferry(page)).waitFor() },
      );

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
      await welcome(page).waitFor();
      await startSigningIn(page);
      const first = await codeOf(page).textContent();
      await atMicrosoft(page, { decline: '1' });
      const refusal = page.getByRole('alert').filter({ hasText: 'The sign-in didn’t finish.' });
      await refusal
        .getByText('You declined the sign-in at Microsoft.')
        .waitFor({ timeout: 15_000 });
      await expectUsable(page, `outlook-${size}-declined`);

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
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expectUsable(page, `outlook-${size}-${scheme}-code`);
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
      await expectUsable(page, `outlook-${size}-dark-lapsed`);
      if (size === 'desktop') {
        // Folded, its stamp says so too.
        await page.keyboard.press('ControlOrMeta+b');
        await sidebar.getByRole('button', { name: /^trailmix\.test, Sign in again/ }).waitFor();
        await expectUsable(page, `outlook-${size}-dark-lapsed-rail`);
        await page.keyboard.press('ControlOrMeta+b');
      }
      // Its menu offers the fix.
      await sidebar.getByRole('button', { name: 'More for trailmix.test' }).click();
      await page.getByRole('menuitem', { name: 'Sign in to trailmix.test again' }).click();

      const again = page.getByRole('region', { name: 'Signing in at Microsoft' });
      await codeOf(page).waitFor();
      await expectUsable(page, `outlook-${size}-dark-again`);
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
      const page = await app.open(SIZES.desktop, { ready: (page) => welcome(page).waitFor() });
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
