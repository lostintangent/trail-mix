import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page, Route } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';

/**
 * Mail on its way stays out of Drafts, end to end: the built app on workerd, sending the demo
 * mailbox's drafts through a mail server that files its own copy of what it accepts in Sent a
 * moment late, as Zoho's does, so the Outbox holds each accepted send while it waits. From the
 * press of Send, a draft's conversation is out of the Drafts list and the draft out of its count,
 * and it never shows again unless the send is undone or fails. The Outbox's count leaves out what
 * the server has accepted. Each page records every count and row it draws, so a flicker between
 * snapshots fails the test, however brief.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({
  vars: { DEV_MEMBER: `drafts-${Date.now()}@trailmix.test`, DEMO_HOST_FILES_SENT: 'true' },
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

/** What a page drew at one moment: the Drafts and Outbox counts, and the subjects in the list. */
type Drawn = { at: number; drafts: string; outbox: string; rows: string[] };

/** A browser on the unified Drafts, once the Mailroom has filled it, recording what it draws. */
async function open(options: BrowserContextOptions): Promise<Page> {
  const page = await (await app.context({ deviceScaleFactor: 2, ...options })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  await goTo(page, 'Drafts');
  await page.getByRole('option').first().waitFor();
  await page.evaluate(() => {
    const drawn: Drawn[] = [];
    Object.assign(window, { drawn });
    // A unified view's button reads as its name, then its count, if any.
    const count = (name: string) =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.startsWith(name))
        ?.textContent.slice(name.length) ?? '';
    const note = () => {
      const now = {
        at: Date.now(),
        drafts: count('Drafts'),
        outbox: count('Outbox'),
        rows: [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent),
      };
      const last = drawn.at(-1);
      if (
        last?.drafts !== now.drafts ||
        last.outbox !== now.outbox ||
        last.rows.join('\n') !== now.rows.join('\n')
      ) {
        drawn.push(now);
      }
    };
    note();
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  return page;
}

/** Everything a page has drawn since it opened on Drafts. */
const drawn = (page: Page) => page.evaluate(() => (window as unknown as { drawn: Drawn[] }).drawn);

/** Each value one of a page's counts went through, once per change, as numbers. */
async function counted(page: Page, which: 'drafts' | 'outbox') {
  const values = (await drawn(page)).map((seen) => Number(seen[which]));
  return values.filter((value, at) => at === 0 || value !== values[at - 1]);
}

/** Whether each change a page drew had a conversation with `subject` in its list, once per change. */
async function listed(page: Page, subject: string) {
  const values = (await drawn(page)).map(({ rows }) => rows.some((row) => row.includes(subject)));
  return values.filter((value, at) => at === 0 || value !== values[at - 1]);
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

/** Opens a draft from the Drafts view in the composer, and sends it. */
async function sendDraft(page: Page, subject: RegExp) {
  await page.getByRole('option', { name: subject }).click();
  await page
    .getByRole('region', { name: 'Reader' })
    .getByRole('button', { name: /^Draft/ })
    .click();
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
}

/** The Drafts view's row for a conversation. */
const row = (page: Page, subject: RegExp) => page.getByRole('option', { name: subject });

/** What the undo toast says, as drawn first. Its words are also announced, in a hidden live region. */
const toast = (page: Page, text: RegExp) => page.getByText(text).filter({ visible: true }).first();

/** Each state of the sends in every snapshot of the Outbox the page is sent, with when it came. */
function outboxSnapshots(page: Page) {
  const snapshots: { at: number; states: string[] }[] = [];
  page.on('response', async (response) => {
    const asked = decodeURIComponent(response.url());
    if (!asked.includes('/_serverFn/') || !asked.includes('{"t":1,"s":"outbox"}')) return;
    const text = await response.text().catch(() => '');
    const states = [...text.matchAll(/"s":"(waiting|sending|accepted|failed)"/g)].map(
      ([, state]) => state!,
    );
    snapshots.push({ at: Date.now(), states });
  });
  return snapshots;
}

/** Has the Mailroom answer each snapshot of `query` only after `ms`. */
async function slow(page: Page, query: 'folders' | 'outbox', ms: number) {
  await page.route('**/_serverFn/**', async (route: Route) => {
    const asked = decodeURIComponent(route.request().url());
    if (route.request().method() !== 'GET' || !asked.includes(`{"t":1,"s":"${query}"}`)) {
      return route.fallback();
    }
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fulfill({ response });
  });
}

async function readable(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `drafts-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}

test('a send undone leaves Drafts at the press, and comes back to it as it was', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  const [drafts] = await counted(page, 'drafts');
  await sendDraft(page, /Lunch Thursday/);
  const counting = toast(page, /^Sending to Jonas in \d+s$/);
  await counting.waitFor();
  // Out of the list and the count while the toast still counts down.
  await row(page, /Lunch Thursday/).waitFor({ state: 'detached', timeout: 2_000 });
  await counting.click({ trial: true });
  await readable(page, 'desktop-light-counting');

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await toast(page, /^Undone\. Nothing was sent to Jonas\.$/).waitFor();
  await row(page, /Lunch Thursday/).waitFor();
  await page.waitForTimeout(1_000);
  expect(await counted(page, 'drafts')).toEqual([drafts!, drafts! - 1, drafts!]);
  expect(await counted(page, 'outbox')).toEqual([0, 1, 0]);
  expect(await listed(page, 'Lunch Thursday')).toEqual([true, false, true]);
}, 60_000);

test('an accepted send waits for the server’s copy out of Drafts, its count and the Outbox’s', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  const [drafts] = await counted(page, 'drafts');
  const outbox = outboxSnapshots(page);
  // The folders' counts lag the Outbox by a second, as when Drafts syncs after the send has gone.
  await slow(page, 'folders', 1_000);
  await sendDraft(page, /Lunch Thursday/);
  await row(page, /Lunch Thursday/).waitFor({ state: 'detached', timeout: 2_000 });

  // The server accepts it, and its copy comes a moment later.
  await waitUntil(() => outbox.some(({ states }) => states.includes('accepted')), 20_000);
  await readable(page, 'desktop-dark-accepted');
  await waitUntil(() => outbox.at(-1)?.states.length === 0, 20_000);
  // Drafts has synced since, and its count follows.
  await page.waitForTimeout(3_000);

  expect(await counted(page, 'drafts')).toEqual([drafts!, drafts! - 1]);
  expect(await counted(page, 'outbox')).toEqual([0, 1, 0]);
  expect(await listed(page, 'Lunch Thursday')).toEqual([true, false]);
  // The Outbox's count let the send go once the server accepted it, before the Outbox did.
  const accepted = outbox.find(({ states }) => states.includes('accepted'))!.at;
  const gone = outbox.find(({ at, states }) => at > accepted && states.length === 0)!.at;
  const seen = await drawn(page);
  // Out of Drafts' count from the press, long before the server had it.
  const dropped = seen.find((drawn) => Number(drawn.drafts) === drafts! - 1)!;
  expect(dropped.at).toBeLessThan(accepted - 2_000);
  const waiting = seen.findIndex(({ outbox }) => outbox === '1');
  const uncounted = seen.slice(waiting).find(({ outbox }) => outbox === '')!;
  expect(uncounted.at).toBeGreaterThanOrEqual(accepted - 100);
  expect(uncounted.at).toBeLessThan(gone);
}, 60_000);

test('a count the folders lower before the Outbox lets the send go never drops twice', async () => {
  const page = await open({ ...PHONE, colorScheme: 'dark' });
  const [drafts] = await counted(page, 'drafts');
  const outbox = outboxSnapshots(page);
  // The Outbox's snapshots lag the folders' by a second, so Drafts' count falls before it says why.
  await slow(page, 'outbox', 1_000);
  await sendDraft(page, /Offsite agenda/);
  await toast(page, /^Sending to Sofia and 2 others in \d+s$/).waitFor();
  await goTo(page, 'Drafts');
  await row(page, /Offsite agenda/).waitFor({ state: 'detached', timeout: 2_000 });
  await waitUntil(() => outbox.some(({ states }) => states.includes('accepted')), 20_000);
  await readable(page, 'phone-dark-accepted');
  await waitUntil(() => outbox.at(-1)?.states.length === 0, 20_000);
  await page.waitForTimeout(3_000);

  expect(await counted(page, 'drafts')).toEqual([drafts!, drafts! - 1]);
  expect(await listed(page, 'Offsite agenda')).toEqual([true, false]);
  const accepted = outbox.find(({ states }) => states.includes('accepted'))!.at;
  const dropped = (await drawn(page)).find((drawn) => Number(drawn.drafts) === drafts! - 1)!;
  expect(dropped.at).toBeLessThan(accepted - 2_000);
}, 60_000);

test('a send the server refuses is back in Drafts, and counted there again', async () => {
  const page = await open({ ...PHONE, colorScheme: 'light' });
  const [drafts] = await counted(page, 'drafts');
  await sendDraft(page, /Cabin/);
  await toast(page, /^Sending to Rae in \d+s$/).waitFor();
  await goTo(page, 'Drafts');
  await row(page, /Cabin/).waitFor({ state: 'detached', timeout: 2_000 });
  await readable(page, 'phone-light-counting');
  await toast(page, /^Couldn’t send to Rae\. The mail server refused it: 554/).waitFor({
    timeout: 30_000,
  });
  await row(page, /Cabin/).waitFor();
  await page.waitForTimeout(1_000);
  await readable(page, 'phone-light-refused');

  expect(await counted(page, 'drafts')).toEqual([drafts!, drafts! - 1, drafts!]);
  // A send that waits for the member stays in the Outbox's count.
  expect(await counted(page, 'outbox')).toEqual([0, 1]);
  expect(await listed(page, 'Cabin')).toEqual([true, false, true]);
}, 60_000);

/** Waits until `isDone`, looking every 50 ms. */
async function waitUntil(isDone: () => boolean, timeout: number) {
  const ends = Date.now() + timeout;
  while (!isDone()) {
    if (Date.now() > ends) throw new Error(`Still waiting after ${timeout} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
