import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';

/**
 * The Outbox, end to end: the built app on workerd, sending the demo mailbox's drafts. The undo toast
 * counts down to the time the Mailroom stored and refuses visibly once that time has come, a send
 * later leaves at its time, and a refused send keeps the server's reason until Retry sends it. A
 * fresh member each run starts from the seeded drafts.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({ vars: { DEV_MEMBER: `outbox-${Date.now()}@trailmix.test` } });
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

/** A browser on the unified Inbox, once the Mailroom has filled it. */
async function open(options: BrowserContextOptions): Promise<Page> {
  const page = await (await app.context({ deviceScaleFactor: 2, ...options })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/** Goes to one of the sidebar's views, such as Drafts or Outbox. */
async function goTo(page: Page, view: string) {
  if (isPhone(page)) {
    // A pane off a phone's screen is inert, so only the reader's own Back is in view.
    const back = page.getByRole('button', { name: 'Back' });
    if (await back.evaluate((button) => !button.closest('[inert]'))) await back.click();
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
  }
  await page
    .getByRole('button', { name: new RegExp(`^${view}`) })
    .first()
    .click();
}

/** Opens a draft from the Drafts view in the composer, ready to send. */
async function openDraft(page: Page, subject: RegExp) {
  await goTo(page, 'Drafts');
  await page.getByRole('option', { name: subject }).click();
  await page
    .getByRole('region', { name: 'Reader' })
    .getByRole('button', { name: /^Draft/ })
    .click();
  await send(page).waitFor();
}

/** The composer's Send button. */
const send = (page: Page) =>
  page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true });

/** What the undo toast says, as drawn first. Its words are also announced, in a hidden live region. */
const toast = (page: Page, text: RegExp) => page.getByText(text).filter({ visible: true }).first();

/** The `sendAt` the Mailroom stored for the next send this page asks for. */
function storedSendAt(page: Page): Promise<number> {
  return new Promise((resolve) => {
    page.on('response', async (response) => {
      if (
        !response.url().includes('/_serverFn/') ||
        !response.request().postData()?.includes('"send"')
      )
        return;
      // An Outgoing carries one instant, its sendAt.
      const at = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/.exec(await response.text())?.[0];
      if (at) resolve(Date.parse(at));
    });
  });
}

/** Whether a send's row in the Outbox carries the airmail stripe. */
const hasAirmail = (page: Page, to: RegExp) =>
  page
    .getByRole('listitem')
    .filter({ hasText: to })
    .evaluate((row) =>
      [...row.children].some((child) =>
        getComputedStyle(child).backgroundImage.includes('repeating-linear-gradient'),
      ),
    );

async function readable(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `outbox-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}

test('the countdown matches the time the Mailroom stored, and Undo leaves the draft unsent', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await openDraft(page, /Lunch Thursday/);
  const stored = storedSendAt(page);
  await send(page).click();
  const counting = toast(page, /^Sending to Jonas in \d+s$/);
  await counting.waitFor();
  const shown = Number(/in (\d+)s/.exec(await counting.innerText())![1]);
  const left = Math.ceil(((await stored) - Date.now()) / 1000);
  // Never more time than the Mailroom gives, and no more than a second less.
  expect(shown).toBeLessThanOrEqual(left);
  expect(shown).toBeGreaterThanOrEqual(left - 1);

  await goTo(page, 'Outbox');
  const row = page.getByRole('listitem').filter({ hasText: /To Jonas Weber/ });
  await expect(row.getByText(/^in \d+s$/).innerText()).resolves.toMatch(/^in \d+s$/);
  expect(await hasAirmail(page, /To Jonas Weber/)).toBe(true);
  await readable(page, 'desktop-light-counting');

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await toast(page, /^Undone\. Nothing was sent to Jonas\.$/).waitFor();
  await page.getByRole('heading', { name: 'Nothing is leaving' }).waitFor();
  await goTo(page, 'Drafts');
  await page.getByRole('option', { name: /Lunch Thursday/ }).waitFor();
}, 60_000);

test('an Undo that reaches the Mailroom after the send’s time is refused, and says so', async () => {
  const page = await open({ ...PHONE, colorScheme: 'dark' });
  await openDraft(page, /Lunch Thursday/);
  const stored = storedSendAt(page);
  await send(page).click();
  await toast(page, /^Sending to Jonas in \d+s$/).waitFor();
  await readable(page, 'phone-dark-counting');
  // Hold the Undo back until the send's time has passed.
  const due = await stored;
  await page.route('**/_serverFn/**', async (route) => {
    if (route.request().postData()?.includes('"cancelSend"'))
      await new Promise((done) => setTimeout(done, due - Date.now() + 1_000));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await toast(page, /^Too late to undo\. (Sending to Jonas…|Sent to Jonas)$/).waitFor({
    timeout: 20_000,
  });
  const sent = toast(page, /^Too late to undo\. Sent to Jonas$/);
  await sent.waitFor({ timeout: 20_000 });
  const card = sent.locator('xpath=..');
  await expect(card.getByRole('button', { name: 'Undo' }).count()).resolves.toBe(0);
  await goTo(page, 'Drafts');
  await page.getByRole('option', { name: /Cabin/ }).waitFor();
  await expect(page.getByRole('option', { name: /Lunch Thursday/ }).count()).resolves.toBe(0);
}, 60_000);

test('a send the server refuses keeps its reason in the Outbox, and Retry sends it', async () => {
  // The demo refuses a message's first try only, so one size sees the refusal.
  const page = await open({ ...PHONE, colorScheme: 'light' });
  await openDraft(page, /Cabin/);
  await send(page).click();
  await toast(page, /^Couldn’t send to Rae\. The mail server refused it: 554/).waitFor({
    timeout: 30_000,
  });
  await readable(page, 'phone-light-refused');
  await page.getByRole('button', { name: 'Open Outbox' }).click();
  const row = page.getByRole('listitem').filter({ hasText: /To Rae Holm/ });
  await row.getByText(/554 5\.4\.4 unreachable\.example can’t be reached right now/).waitFor();
  expect(await hasAirmail(page, /To Rae Holm/)).toBe(false);
  await readable(page, 'phone-light-failed');
  await row.getByRole('button', { name: 'Retry' }).click();
  await page.getByRole('heading', { name: 'Nothing is leaving' }).waitFor({ timeout: 30_000 });
}, 60_000);

test('a send later leaves the Outbox at its time, not before', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await openDraft(page, /Offsite agenda/);
  // The next whole minute at least 20 seconds off, in the browser's own time zone, which the test
  // runner's may not share.
  const at = new Date(Math.ceil((Date.now() + 20_000) / 60_000) * 60_000);
  const local = await page.evaluate((ms) => {
    const date = new Date(ms);
    const two = (n: number) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
    return `${day}T${two(date.getHours())}:${two(date.getMinutes())}`;
  }, at.getTime());
  await page.getByRole('button', { name: 'Send later' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Pick a date and time…' }).click();
  await page.getByLabel('Send at').fill(local);
  await page.getByRole('button', { name: 'Schedule' }).click();
  await toast(page, /^Sending to Sofia and 2 others Today /).waitFor();

  await goTo(page, 'Outbox');
  const row = page.getByRole('listitem').filter({ hasText: /Offsite agenda/ });
  await row.getByText(/^Today /).waitFor();
  expect(await hasAirmail(page, /Offsite agenda/)).toBe(true);
  await readable(page, 'desktop-light-scheduled');
  await row.waitFor({ state: 'detached', timeout: 90_000 });
  expect(Date.now()).toBeGreaterThanOrEqual(at.getTime());
  await page.getByRole('heading', { name: 'Nothing is leaving' }).waitFor();
}, 120_000);
