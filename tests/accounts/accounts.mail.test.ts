// Accounts, end to end: the built app on workerd, without the demo mailbox, against the test mail
// server. A member with no accounts is told who can read what Trail Mix stores, and adds an account
// from the first-run screen. A password the host refuses keeps nothing, and the screen says why. An
// account's name, stamp, From name and signature change from its page, and removing it says what
// goes first. Each is done at a desktop's size and a phone's, as a member of its own.
import { afterEach, beforeAll, describe, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContextOptions, Locator, Page } from 'playwright';
import { PRESETS } from '../../src/features/providers/imap/core/index.ts';
import { unusable } from '../e2e/usable.ts';
import { suite } from '../e2e/suite.ts';
import { caFile, count, empty, importInbox, ports, start, users } from '../mail-server/server.ts';

const { alice, bob } = users;
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;
const WRONG = 'not-alices-password';
const SHOTS = join(import.meta.dir, '../../test-results');

// The test mail server starts first, since it makes the certificate authority the app trusts.
beforeAll(async () => {
  await start('full');
  await empty(alice.email);
  const mbox = join(mkdtempSync(join(tmpdir(), 'accounts-')), 'inbox');
  writeFileSync(
    mbox,
    [
      `From ${bob.email} Tue Nov 10 09:00:00 2026`,
      `From: Bob <${bob.email}>`,
      `To: ${alice.email}`,
      'Subject: The cabin keys',
      'Message-ID: <keys@trailmix.test>',
      `Date: ${new Date().toUTCString()}`,
      '',
      'They are under the blue pot.',
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

for (const [size, options] of Object.entries(SIZES)) {
  describe(`At a ${size}’s size`, () => {
    const app = suite({
      vars: { DEMO_MAILBOX: '', DEV_MEMBER: `accounts-${size}-${Date.now()}@trailmix.test` },
      env: { NODE_EXTRA_CA_CERTS: caFile },
    });
    // A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
    const { test } = app;

    async function open(more: BrowserContextOptions = {}): Promise<Page> {
      const page = await (
        await app.context({ deviceScaleFactor: 2, ...options, ...more })
      ).newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      return page;
    }

    /** The sidebar, which a phone slides to from the list. */
    async function sidebar(page: Page) {
      if (size === 'phone')
        await page.getByRole('button', { name: 'Folders', exact: true }).click();
      return page.getByRole('navigation', { name: 'Mailboxes' });
    }

    /** An account's page, from the menu beside its name in the sidebar. */
    async function editAccount(page: Page, name: string) {
      await (await sidebar(page)).getByRole('button', { name: `More for ${name}` }).click();
      await page.getByRole('menuitem', { name: `Edit the ${name} account` }).click();
    }

    const firstRun = (page: Page) => page.getByRole('heading', { name: 'Welcome to Trail Mix' });
    const cabinKeys = (page: Page) =>
      page.getByRole('option').filter({ hasText: 'The cabin keys' });

    test('a member with no accounts is welcomed, and a refused password keeps nothing', async () => {
      const page = await open({ colorScheme: 'light' });
      await firstRun(page).waitFor();

      await fillAlice(page, WRONG);
      if (size === 'phone') {
        expect(await smallTargets(page.getByRole('form', { name: 'Add an account' }))).toEqual([]);
      }
      await page.getByRole('button', { name: 'Add account' }).click();
      const refusal = page.getByRole('alert').filter({ hasText: 'The account wasn’t added.' });
      await refusal.waitFor({ timeout: 15_000 });
      // In the host's own words.
      expect(await refusal.textContent()).toContain(
        'localhost refused the password: [AUTHENTICATIONFAILED] Authentication failed.',
      );
      await readable(page, size, 'light', 'refused');

      // Nothing was kept, so the screen is the same after a reload.
      await page.reload();
      await firstRun(page).waitFor();
      expect(await passwordFound(page)).toEqual([]);
    }, 60_000);

    test('Zoho’s server names come filled in, and the ones typed are the ones asked for', async () => {
      const page = await open();
      const imap = page.getByRole('textbox', { name: 'IMAP server' });
      expect(await imap.inputValue()).toBe(PRESETS.zoho.imap.host);
      expect(await page.getByRole('textbox', { name: 'SMTP server' }).inputValue()).toBe(
        PRESETS.zoho.smtp.host,
      );
      expect(await page.getByRole('textbox', { name: 'IMAP port' }).count()).toBe(0);

      // The command is stopped here, so no test reaches Zoho.
      const asked: string[] = [];
      await page.route('**/_serverFn/**', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        asked.push(route.request().postData() ?? '');
        await route.abort();
      });
      await page.getByRole('textbox', { name: 'Address' }).fill('sam@trl.example');
      await page.getByLabel('Password', { exact: true }).fill('an app password');
      await imap.fill('imap.zoho.com');
      await page.getByRole('textbox', { name: 'SMTP server' }).fill('smtp.zoho.com');
      await page.getByRole('button', { name: 'Add account' }).click();
      // The form's own alert. Toasts keep an empty one of their own once they load.
      await page.getByRole('alert').filter({ hasText: 'The account wasn’t added.' }).waitFor();
      // The call as the page sent it, with the typed names, Zoho's ports and TLS, and no other host.
      const setup = asked.find((body) => body.includes('addAccount')) ?? '';
      expect(setup).toContain('"s":"zoho"');
      expect(setup).toContain('"s":"imap.zoho.com"},{"t":0,"s":993}');
      expect(setup).toContain('"s":"smtp.zoho.com"},{"t":0,"s":465}');
      expect(setup).not.toContain(PRESETS.zoho.imap.host);
    }, 30_000);

    test('an account added from the first-run screen opens on its mail, here and on another device, and its password is nowhere', async () => {
      const [page, elsewhere] = [await open({ colorScheme: 'dark' }), await open()];
      await firstRun(elsewhere).waitFor();
      await fillAlice(page, alice.password);
      await readable(page, size, 'dark', 'first-run');
      await page.getByRole('button', { name: 'Add account' }).click();
      await cabinKeys(page).waitFor({ timeout: 30_000 });
      await cabinKeys(elsewhere).waitFor({ timeout: 10_000 });
      await (await sidebar(page)).getByRole('region', { name: 'trailmix.test' }).waitFor();
      expect(await passwordFound(page)).toEqual([]);
    }, 60_000);

    test('an account’s name, stamp, From name and signature change from its page', async () => {
      const page = await open({ colorScheme: 'light' });
      await cabinKeys(page).waitFor({ timeout: 30_000 });
      await editAccount(page, 'trailmix.test');

      const form = page.getByRole('form', { name: 'Edit trailmix.test' });
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Alice');
      await form.getByRole('radio', { name: 'Teal' }).check();
      await form.getByRole('textbox', { name: 'From name' }).fill('Alice Liddell');
      await form.getByRole('textbox', { name: 'Signature' }).fill('Alice, down the hole');
      if (size === 'phone') expect(await smallTargets(form)).toEqual([]);
      await readable(page, size, 'light', 'edit');
      await form.getByRole('button', { name: 'Save' }).click();
      await form.waitFor({ state: 'detached' });
      await (await sidebar(page)).getByRole('region', { name: 'Alice' }).waitFor();

      // As the Mailroom keeps it, after a reload: a new message is from the account's new name, with
      // its signature, and its page shows the stamp chosen.
      await page.reload();
      await cabinKeys(page).waitFor({ timeout: 30_000 });
      await page.keyboard.press('c');
      const composer = page.locator('section[aria-label="New message"]');
      await composer.getByText('Alice, down the hole').waitFor();
      await page.keyboard.press('Escape');
      await composer.waitFor({ state: 'detached' });
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.type('edit the alice');
      await page.getByRole('option', { name: 'Edit the Alice account' }).waitFor();
      await page.keyboard.press('Enter');
      const kept = page.getByRole('form', { name: 'Edit Alice' });
      expect(await kept.getByRole('radio', { name: 'Teal' }).isChecked()).toBe(true);
      expect(await kept.getByRole('textbox', { name: 'From name' }).inputValue()).toBe(
        'Alice Liddell',
      );
    }, 60_000);

    test('removing an account says what goes first, and leaves the first-run screen', async () => {
      const page = await open({ colorScheme: 'dark' });
      await cabinKeys(page).waitFor({ timeout: 30_000 });
      await editAccount(page, 'Alice');
      await page.getByRole('button', { name: 'Remove account…' }).click();

      const question = page.getByRole('alertdialog', { name: 'Remove Alice?' });
      await question
        .getByText('Trail Mix forgets Alice: the index of its mail, the copies of messages', {
          exact: false,
        })
        .waitFor();
      await readable(page, size, 'dark', 'remove');
      await question.getByRole('button', { name: 'Remove' }).click();

      await firstRun(page).waitFor();
      await page.reload();
      await firstRun(page).waitFor();
      // The mail stays on the server.
      expect(await count(alice.email, 'INBOX')).toBe(1);
    }, 60_000);
  });
}

/** Fills in Alice's account at the test mail server, as a member would. */
async function fillAlice(page: Page, password: string) {
  await page.getByRole('radio', { name: 'Another IMAP host' }).click();
  await page.getByRole('textbox', { name: 'Address' }).fill(alice.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('textbox', { name: 'IMAP server' }).fill('localhost');
  await page.getByRole('textbox', { name: 'IMAP port' }).fill(String(ports.imaps));
  await page.getByRole('textbox', { name: 'SMTP server' }).fill('localhost');
  await page.getByRole('textbox', { name: 'SMTP port' }).fill(String(ports.submissions));
}

/**
 * Where the page still holds a password typed into it: its address, its storage, its markup, and
 * anything a script can still reach once garbage is collected, read from a snapshot of its heap.
 */
async function passwordFound(page: Page): Promise<string[]> {
  const found: string[] = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  let heap = '';
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => (heap += chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await cdp.detach();
  for (const password of [alice.password, WRONG]) {
    const places = await page.evaluate(
      (secret) =>
        [
          ['address', location.href],
          ['local storage', JSON.stringify({ ...localStorage })],
          ['session storage', JSON.stringify({ ...sessionStorage })],
          ['cookies', document.cookie],
          ['markup', document.documentElement.outerHTML],
        ].flatMap(([where, text]) => (text?.includes(secret) ? [where ?? ''] : [])),
      password,
    );
    found.push(...places.map((where) => `${password} in ${where}`));
    if (heap.includes(password)) found.push(`${password} in the heap`);
  }
  return found;
}

/** The controls in a form that a finger can't be sure to hit, by name. */
function smallTargets(within: Locator): Promise<string[]> {
  return within.locator('input, button, textarea').evaluateAll((controls) =>
    controls.flatMap((control) => {
      // A field's whole box takes a tap and gives the field the focus.
      const target =
        control.closest('label') ??
        (control.tagName === 'INPUT' ? control.parentElement : control) ??
        control;
      const box = target.getBoundingClientRect();
      if (box.height === 0) return [];
      return box.height < 44 || box.width < 44
        ? [control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName]
        : [];
    }),
  );
}

/** Saves the screen, and fails if any of its text falls under 4.5:1. */
async function readable(page: Page, size: string, scheme: string, screen: string) {
  await page.screenshot({ path: join(SHOTS, `accounts-${size}-${scheme}-${screen}.png`) });
  expect({ screen, unusable: await unusable(page) }).toEqual({ screen, unusable: [] });
}
