import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toJSON } from 'seroval';
import type { Page } from 'playwright';
import { unreadableText } from './contrast.ts';
import { checkDemo } from './demo-check.ts';
import { VISITOR_SECONDS } from '../../src/server/access.ts';
import { BUILDS, serverFunctionIds } from './preview.ts';
import { suite } from './suite.ts';

/**
 * The public demo as visitors meet it: the demo build on workerd, as deployed, with no sign-in.
 * Each visitor gets the demo mailbox in a Mailroom of their own, the day lets in only so many, and
 * past them the demo says it is full and makes no Mailroom. A network makes only so many changes a
 * minute. `access.test.ts` covers the visitor's cookie, `visitors.test.ts` the gate, and the
 * Mailroom's tests what a visitor's Mailroom checks and keeps.
 */

/** How many new visitors this demo lets in today. The suite's tests take every place in turn. */
const A_DAY = 6;
/** How many changes the demo takes a minute from one network, as `wrangler.jsonc` sets it. */
const CHANGES_A_MINUTE = 300;
const ROOT = join(import.meta.dir, '../..');
const SHOTS = join(ROOT, 'test-results');
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

const VISITOR_KEY = crypto.randomUUID().repeat(2);
const app = suite({
  build: BUILDS.demo,
  vars: { VISITOR_KEY, NEW_VISITORS_A_DAY: String(A_DAY) },
});
const { test } = app;

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

/**
 * How many Mailrooms the demo has made: one database each, beside the namespace's own, where the
 * preview keeps each Durable Object, by Worker and class.
 */
const mailrooms = () =>
  readdirSync(join(app.state, 'v3/do/trail-mix-demo-Mailroom')).filter(
    (file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite',
  ).length;

/** A new visitor's browser, at the demo's Inbox once it has filled. */
async function visitor(): Promise<Page> {
  const page = await (await app.context(SIZES.desktop)).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

/** The subject of the conversation the reader shows, once the list's selection is it. */
async function shownSubject(page: Page): Promise<string> {
  const shown = await page.waitForFunction(() => {
    const title = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
    const selected = document.querySelector('[role="option"][aria-selected="true"]');
    return title && selected?.textContent?.includes(title) ? title : undefined;
  });
  return (await shown.jsonValue()) as string;
}

/** The visitor cookie a browser holds. */
const cookieOf = async (page: Page) =>
  (await page.context().cookies()).find(({ name }) => name === '__Host-visitor')?.value;

test('the deploy’s check finds the demo mailbox open to a new visitor, and no real account', async () => {
  expect(await checkDemo(app.url)).toBe('opened');
  expect(mailrooms()).toBe(1);
}, 60_000);

test('each visitor opens the demo mailbox in a Mailroom of their own, which no other reaches', async () => {
  const ana = await visitor();
  const rows = ana.getByRole('option');
  await rows.first().click();
  const subject = await shownSubject(ana);
  await ana.keyboard.press('e');
  await rows.filter({ hasText: subject }).waitFor({ state: 'detached', timeout: 5_000 });

  // Another visitor has the whole demo mailbox, the conversation Ana archived among it.
  const ben = await visitor();
  await ben.getByRole('option').filter({ hasText: subject }).waitFor();
  const [anas = '', bens = ''] = [await cookieOf(ana), await cookieOf(ben)];
  expect(anas).toMatch(/^[0-9a-f]{32}\.\d{10}\./);
  expect(bens).toMatch(/^[0-9a-f]{32}\.\d{10}\./);
  expect(anas.slice(0, 32)).not.toBe(bens.slice(0, 32));
  expect(mailrooms()).toBe(3);
}, 90_000);

test('a visitor can’t add an account of their own, or remove or erase the demo’s', async () => {
  const cy = await visitor();
  const imap = {
    provider: 'imap',
    name: 'Mine',
    address: 'me@example.com',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
    password: 'not-a-real-password',
  };
  const said = async (name: string, ...args: unknown[]) =>
    cy.evaluate(
      async ([url, call]) => {
        const form = new FormData();
        form.set('call', call);
        const response = await fetch(url, {
          method: 'POST',
          body: form,
          headers: { 'x-tsr-serverFn': 'true' },
        });
        return response.text();
      },
      [
        `/_serverFn/${serverFunctionIds(BUILDS.demo).command}`,
        JSON.stringify({ name, args }),
      ] as const,
    );
  expect(await said('addAccount', imap)).toContain('only the demo mailbox');
  expect(await said('removeAccount', crypto.randomUUID())).toContain('keeps its two accounts');
  expect(await said('eraseEverything')).toContain('keeps its two accounts');
  expect(mailrooms()).toBe(4);
}, 60_000);

test('holding E down archives the whole Inbox within the change limit, which stops a script', async () => {
  const di = await visitor();
  const changes: string[] = [];
  const refused: string[] = [];
  di.on('request', (request) => {
    if (request.method() === 'POST') changes.push(request.url());
  });
  di.on('response', (response) => {
    if (response.status() === 429) refused.push(response.url());
  });
  const rows = di.getByRole('option');
  await rows.first().click();
  // A held key repeats about 30 times a second at its fastest.
  await di.keyboard.down('e');
  for (let held = 0; held < CHANGES_A_MINUTE && (await rows.count()) > 0; held++) {
    await di.keyboard.down('e');
    await di.waitForTimeout(33);
  }
  await di.keyboard.up('e');
  await di.getByRole('option').first().waitFor({ state: 'detached', timeout: 10_000 });
  await di.waitForLoadState('networkidle');
  console.log(`Archiving the whole Inbox took ${changes.length} changes.`);
  expect(refused).toEqual([]);
  expect(changes.length).toBeLessThan(CHANGES_A_MINUTE);

  // A script holding the same cookie, sending changes as fast as it can, is refused past the
  // limit. Windows start on the minute, so these may span two of them, and two take 600 at most.
  // A notification's button with nothing to do is a change that writes nothing.
  const cookie = `__Host-visitor=${await cookieOf(di)}`;
  const act = new URL('/notifications/act', app.url);
  const statuses: number[] = [];
  for (let batch = 0; batch < 14; batch++) {
    statuses.push(
      ...(await Promise.all(
        Array.from({ length: 50 }, async () => {
          const response = await fetch(act, {
            method: 'POST',
            body: '{}',
            headers: {
              Cookie: cookie,
              Origin: new URL(app.url).origin,
              'Sec-Fetch-Site': 'same-origin',
            },
          });
          await response.body?.cancel();
          return response.status;
        }),
      )),
    );
  }
  const taken = statuses.filter((status) => status === 400).length;
  expect(taken + statuses.filter((status) => status === 429).length).toBe(700);
  expect(taken).toBeLessThanOrEqual(2 * CHANGES_A_MINUTE - changes.length);
  expect(mailrooms()).toBe(5);
}, 90_000);

test('a page load makes no Mailroom, and a script makes no more new visitors than the day allows', async () => {
  // Crawlers and link previews only load the page, which takes no place.
  for (let load = 0; load < 5; load++) {
    const page = await fetch(app.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('Set-Cookie')).toMatch(/^__Host-visitor=[0-9a-f]{32}\.new\./);
  }
  expect(mailrooms()).toBe(5);

  // A burst of new visitors at once, as a script would send, gets the day's last place and no more.
  const accounts = new URL(`/_serverFn/${serverFunctionIds(BUILDS.demo).query}`, app.url);
  accounts.searchParams.set(
    'payload',
    JSON.stringify(toJSON({ data: { name: 'accounts', args: [] } })),
  );
  const statuses = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const response = await fetch(accounts, {
        headers: { 'x-tsr-serverFn': 'true', 'Sec-Fetch-Site': 'same-origin' },
      });
      await response.body?.cancel();
      return response.status;
    }),
  );
  expect(statuses.filter((status) => status === 200)).toHaveLength(A_DAY - 5);
  expect(statuses.filter((status) => status === 429)).toHaveLength(20 - (A_DAY - 5));
  expect(mailrooms()).toBe(A_DAY);

  // The next visitor's browser is told the demo is full, at both sizes in both themes.
  for (const [size, options] of Object.entries(SIZES)) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await app.context({ deviceScaleFactor: 2, ...options, colorScheme });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.url);
      await page
        .getByRole('heading', { name: 'Trail Mix’s demo is full for now' })
        .waitFor({ timeout: 10_000 });
      await page.screenshot({ path: join(SHOTS, `${size}-${colorScheme}-demo-full.png`) });
      const screen = `${size} ${colorScheme} demo full`;
      expect({ screen, unreadable: await unreadableText(page) }).toEqual({
        screen,
        unreadable: [],
      });
      await context.close();
    }
  }
  // So the deploy's check can only say so.
  expect(await checkDemo(app.url)).toBe('full');

  // Nor does a cookie banked from an earlier day, which the demo signed when its gate let the
  // visitor in, make a Mailroom without asking the gate again.
  const banked = await fetch(accounts, {
    headers: {
      'x-tsr-serverFn': 'true',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: await visitorCookie(Math.floor(Date.now() / 1000) - VISITOR_SECONDS),
    },
  });
  await banked.body?.cancel();
  expect(banked.status).toBe(429);
  expect(mailrooms()).toBe(A_DAY);
}, 90_000);

/** A cookie the demo would have given a new visitor its gate let in at `letIn`, in seconds. */
async function visitorCookie(letIn: number): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(VISITOR_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const value = `${id}.${letIn}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`trail-mix visitor ${value}`),
  );
  return `__Host-visitor=${value}.${Buffer.from(signature).toString('base64url')}`;
}
