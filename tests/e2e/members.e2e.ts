import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { cloudflareStandIn, STAND_IN_AUD } from '../cloudflare-stand-in.ts';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';

/**
 * Members, in Settings, as the operator uses it: the built app with the development member as the
 * operator, and a stand-in for Cloudflare's API holding the Access policy. Inviting, listing and
 * removing each change the stand-in's policy, and a removal Cloudflare half refuses says so.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const OPERATOR = `members-${Date.now()}@trailmix.test`;

const cloudflare = cloudflareStandIn({
  members: [OPERATOR, 'bo@example.org'],
  alsoInclude: [{ email_domain: { domain: 'family.example' } }],
});
const server = Bun.serve({ port: 0, fetch: (request) => cloudflare.handle(request) });

const app = suite({
  vars: {
    DEV_MEMBER: OPERATOR,
    OPERATOR_EMAIL: OPERATOR,
    ACCESS_AUD: STAND_IN_AUD,
    CLOUDFLARE_ACCOUNT_ID: 'account',
    ACCESS_API_TOKEN: 'a-stand-in-token',
    CLOUDFLARE_API: `${server.url.origin}/client/v4`,
  },
});

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
  cloudflare.lastSeen.set('bo@example.org', '2026-11-09T18:30:00Z');
});
afterAll(() => server.stop(true));

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

async function membersPage(options: BrowserContextOptions): Promise<Page> {
  const page = await (await app.context({ deviceScaleFactor: 2, ...options })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await mailIsIn(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('members');
  await page.getByRole('option', { name: 'Members' }).waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('list', { name: 'Members' }).waitFor();
  return page;
}

const row = (page: Page, email: string) =>
  page.getByRole('list', { name: 'Members' }).getByRole('listitem').filter({ hasText: email });

async function readable(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `members-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}

test('the operator sees each member’s last sign-in, and what else the policy admits, in Settings', async () => {
  const page = await membersPage({ ...DESKTOP, colorScheme: 'light' });
  await row(page, OPERATOR).getByText('You, the operator', { exact: false }).waitFor();
  await row(page, 'bo@example.org').getByText('Last signed in', { exact: false }).waitFor();
  expect(await row(page, OPERATOR).getByRole('button', { name: 'Remove' }).count()).toBe(0);
  await page.getByText('Everyone at family.example').waitFor();
  // The palette's Members is a section of Settings, which the gear opens too, and nothing else does.
  const settings = page.getByRole('region', { name: 'Settings' });
  for (const section of ['Appearance', 'Members']) {
    await settings.getByRole('heading', { name: section, level: 2 }).waitFor();
  }
  await readable(page, 'desktop-light');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  expect(await sidebar.getByRole('button', { name: 'Members' }).count()).toBe(0);
  await sidebar.getByRole('button', { name: 'Open settings' }).click();
  await settings.getByRole('list', { name: 'Members' }).waitFor();
}, 60_000);

test('an invitation joins the policy, and says what to send them', async () => {
  const page = await membersPage({ ...PHONE, colorScheme: 'dark' });
  const field = page.getByRole('textbox', { name: 'Invite by email address' });
  await field.fill('kid@family.example');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page
    .getByText(
      'kid@family.example can already sign in, since the policy admits everyone at family.example.',
    )
    .first()
    .waitFor();

  await field.fill('Cy@Example.org');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const sent = page.getByRole('status').filter({ hasText: 'cy@example.org' });
  await sent
    .getByText(`Open ${app.url.replace(/\/$/, '')} and sign in with cy@example.org`, {
      exact: false,
    })
    .waitFor();
  await row(page, 'cy@example.org').waitFor();
  expect(cloudflare.members).toContain('cy@example.org');
  await readable(page, 'phone-dark-invited');
}, 60_000);

test('a removal Cloudflare half refuses says so, and trying again finishes it', async () => {
  const page = await membersPage({ ...DESKTOP, colorScheme: 'dark' });
  cloudflare.refusing.set('/access/organizations/revoke_user', 'Authentication error');
  await row(page, 'bo@example.org').getByRole('button', { name: 'Remove' }).click();
  const asking = page.getByRole('group', { name: 'Remove bo@example.org' });
  expect(
    await asking
      .getByRole('checkbox', { name: 'Also erase what Trail Mix holds for them' })
      .isChecked(),
  ).toBe(true);
  await asking.getByRole('button', { name: 'Remove' }).click();
  // The row leaves with the address, and what's left undone stays on the page.
  const unfinished = page
    .getByRole('alert')
    .filter({ hasText: 'Removing bo@example.org isn’t finished.' });
  await unfinished
    .getByText('bo@example.org is off the list, but Trail Mix couldn’t end their sign-in', {
      exact: false,
    })
    .waitFor();
  await row(page, 'bo@example.org').waitFor({ state: 'detached' });
  expect(cloudflare.members).not.toContain('bo@example.org');
  await readable(page, 'desktop-dark-half-removed');

  cloudflare.refusing.clear();
  await unfinished.getByRole('button', { name: 'Try again' }).click();
  await unfinished.waitFor({ state: 'detached' });
  expect(
    cloudflare.calls.filter(({ path }) => path === '/access/organizations/revoke_user').at(-1)
      ?.body,
  ).toEqual({ email: 'bo@example.org' });
}, 60_000);
