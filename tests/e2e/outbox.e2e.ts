import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';

/**
 * The Outbox, end to end: the built app on workerd, sending the demo mailbox's drafts. The undo toast
 * counts down to the time the Mailroom stored and refuses visibly once that time has come, a send
 * later waits in the Outbox, and a refused send keeps the server's reason until Retry sends it. A
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
  await mailIsIn(page);
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
      [...row.querySelectorAll('*')].some((part) =>
        getComputedStyle(part).backgroundImage.includes('repeating-linear-gradient'),
      ),
    );

/**
 * That a toast reads across its card: what it says shares a line with its actions only while it
 * fits on one, and otherwise takes the card's width, with its actions at the end of a line beneath
 * it, each a 44-pixel target under a finger. How many lines that takes is the font's to say.
 */
async function readsAcross(page: Page, text: RegExp) {
  const shape = await toast(page, text).evaluate((said) => {
    const row = said.parentElement!.parentElement!;
    const box = said.getBoundingClientRect();
    const style = getComputedStyle(said);
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    const actions = [...row.querySelectorAll('button')].map((button) =>
      button.getBoundingClientRect(),
    );
    return {
      lines: Math.round(box.height / line),
      share: box.width / row.getBoundingClientRect().width,
      isBeneath: actions.every(({ top }) => top >= box.bottom - 1),
      isReachable: actions.every(({ width, height }) => width >= 44 && height >= 44),
    };
  });
  expect(shape.isReachable).toBe(true);
  if (shape.lines > 1) {
    expect(shape).toMatchObject({ isBeneath: true });
    expect(shape.share).toBeGreaterThan(0.75);
  }
}

/** Has every snapshot of the Outbox show a failed send as one that tries again on its own. */
const retrying = (page: Page) =>
  page.route('**/_serverFn/**', async (route) => {
    const asked = decodeURIComponent(route.request().url());
    if (route.request().method() !== 'GET' || !asked.includes('{"t":1,"s":"outbox"}')) {
      return route.fallback();
    }
    const response = await route.fetch();
    const body = (await response.text()).replaceAll('"s":"failed"', '"s":"waiting"');
    await route.fulfill({ response, body });
  });

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
  // Its Undo is an icon, and its tooltip names the key that takes the send back too.
  await page.locator('.astryx-toast').getByRole('button', { name: 'Undo', exact: true }).hover();
  await page.getByRole('tooltip').filter({ hasText: 'Undo (Z)' }).waitFor();

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

test('a send pressed while a save is on its way waits for it, and leaves when the window from the press closes', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  await openDraft(page, /Lunch Thursday/);
  // Each save answers three seconds late, so the Mailroom hears of the send only after one.
  await page.route('**/_serverFn/**', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST' || !request.postData()?.includes('saveDraft')) {
      return route.fallback();
    }
    const response = await route.fetch();
    await new Promise((done) => setTimeout(done, 3_000));
    await route.fulfill({ response });
  });
  const saving = page.waitForRequest((request) => !!request.postData()?.includes('saveDraft'));
  // Lunch Thursday is a reply, so its body is the reply's.
  await page.getByRole('textbox', { name: /^(Reply|Message)$/ }).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' See you there.');
  await saving;
  const saved = Date.now();
  const stored = storedSendAt(page);
  const pressed = Date.now();
  await send(page).click();
  // It counts down from the press, before the Mailroom has heard of it.
  await toast(page, /^Sending to Jonas in (10|9)s$/).waitFor({ timeout: 1_000 });
  const sendAt = await stored;
  expect(Date.now() - saved).toBeGreaterThan(3_000);
  expect(sendAt - pressed).toBeGreaterThan(9_500);
  expect(sendAt - pressed).toBeLessThan(11_000);

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await toast(page, /^Undone\. Nothing was sent to Jonas\.$/).waitFor();
}, 60_000);

/** Writes a new message from the keyboard, to someone other than the member, ready to send. */
async function write(page: Page, subject: string) {
  await page.keyboard.press('c');
  await page.getByRole('combobox', { name: 'To' }).fill('ari@example.com');
  await page.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Bring the map.');
}

const isSend = (body: string | null) => !!body?.includes('"send"');

test('Send carries what was written since the last save in one request, and goes though the page closes before the answer', async () => {
  const page = await open({ ...PHONE, colorScheme: 'light' });
  const subject = `Gone at once ${Date.now()}`;
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') asked.push(request.postData() ?? '');
  });
  // The Mailroom has the whole request, and the page never hears its answer.
  const answered = Promise.withResolvers<unknown>();
  await page.route('**/_serverFn/**', (route) => {
    if (!route.request().postData()?.includes('"send"')) return route.fallback();
    answered.resolve(route.fetch());
    return Promise.resolve();
  });
  await write(page, subject);
  await send(page).click();
  await answered.promise;
  await page.close();
  expect(asked.filter((body) => body.includes('saveDraft'))).toEqual([]);
  expect(
    asked.filter((body) => body.includes('"send"') && body.includes('Bring the map.')),
  ).toHaveLength(1);

  const again = await open({ ...DESKTOP, colorScheme: 'light' });
  await again
    .getByRole('navigation', { name: 'Mailboxes' })
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Sent( \d+)?$/ })
    .click();
  await again.getByRole('option', { name: new RegExp(subject) }).waitFor({ timeout: 30_000 });
}, 60_000);

test('a Send whose answer is lost asks again under its press, and goes once, with no composer back', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  const subject = `Asked again ${Date.now()}`;
  let asks = 0;
  // The Mailroom has the first ask, and its answer is lost on the way back.
  await page.route('**/_serverFn/**', async (route) => {
    if (!isSend(route.request().postData())) return route.fallback();
    if (asks++ > 0) return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await write(page, subject);
  await send(page).click();
  await toast(page, /^Sent to ari@example\.com$/).waitFor({ timeout: 30_000 });
  expect(asks).toBe(2);
  // Nothing was brought back to write again.
  await expect(send(page).count()).resolves.toBe(0);

  await page
    .getByRole('navigation', { name: 'Mailboxes' })
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Sent( \d+)?$/ })
    .click();
  await page.getByRole('option', { name: new RegExp(subject) }).click({ timeout: 30_000 });
  const reader = page.getByRole('region', { name: 'Reader' });
  await reader.getByRole('heading', { level: 1, name: subject }).waitFor();
  await reader.getByRole('article').first().waitFor();
  await expect(reader.getByRole('article').count()).resolves.toBe(1);
  await goTo(page, 'Drafts');
  await expect(page.getByRole('option', { name: new RegExp(subject) }).count()).resolves.toBe(0);
}, 60_000);

test('an Undo that reaches the Mailroom before its Send stops the send there, and nothing goes', async () => {
  const page = await open({ ...PHONE, colorScheme: 'light' });
  const subject = `Overtaken ${Date.now()}`;
  // The Send reaches the Mailroom only once the Undo has been answered.
  const undone = Promise.withResolvers<void>();
  let asks = 0;
  await page.route('**/_serverFn/**', async (route) => {
    if (!isSend(route.request().postData())) return route.fallback();
    asks++;
    await undone.promise;
    await route.continue();
  });
  await write(page, subject);
  await send(page).click();
  await toast(page, /^Sending to ari@example\.com in \d+s$/).waitFor();
  const cancelled = page.waitForResponse(
    (response) => !!response.request().postData()?.includes('"cancelSend"'),
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await cancelled).ok()).toBe(true);
  await toast(page, /^Undone\. Nothing was sent to ari@example\.com\.$/).waitFor();
  await expect(page.getByRole('textbox', { name: 'Subject' }).inputValue()).resolves.toBe(subject);

  const refused = page.waitForResponse((response) => isSend(response.request().postData()));
  undone.resolve();
  expect(await (await refused).text()).toContain('The send was undone.');
  // The refusal is the Undo's own, so the message stays as it was, and isn't asked for again. This
  // proves no second ask and no failure come: one taken as unanswered is asked again after a second.
  await page.waitForTimeout(1_500);
  expect(asks).toBe(1);
  await expect(page.getByText(/Couldn’t send/).count()).resolves.toBe(0);
  await expect(page.getByRole('textbox', { name: 'Subject' }).inputValue()).resolves.toBe(subject);
}, 60_000);

test('a send straight after a cold load counts down, though toasts and their theme load only then', async () => {
  const page = await (await app.context({ ...DESKTOP, colorScheme: 'dark' })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  // Toasts, and Astryx's theme generator with them, are held back until the send has been answered,
  // so the countdown is asked for before anything can show it.
  let release = () => {};
  const released = new Promise<void>((done) => (release = done));
  let held = 0;
  await page.route('**/assets/toast-host-*.js', async (route) => {
    held++;
    await released;
    await route.continue();
  });
  await page.goto(app.url);
  await openDraft(page, /Lunch Thursday/);
  const stored = storedSendAt(page);
  await send(page).click();
  await stored;
  // The page has taken the answer once the sidebar's Outbox counts the send.
  await page.getByRole('button', { name: /^Outbox\s?1$/ }).waitFor();
  release();

  const counting = toast(page, /^Sending to Jonas in \d+s$/);
  await counting.waitFor();
  const shown = Number(/in (\d+)s/.exec(await counting.innerText())![1]);
  const left = Math.ceil(((await stored) - Date.now()) / 1000);
  expect(shown).toBeLessThanOrEqual(left);
  expect(shown).toBeGreaterThanOrEqual(left - 1);
  // Once it has slid into place, so its words are read where they stay.
  await counting.click({ trial: true });
  await readable(page, 'desktop-dark-first-toast');
  expect(held).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await toast(page, /^Undone\. Nothing was sent to Jonas\.$/).waitFor();
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
  // Seen first as a send that tries again on its own, then as the refusal it is.
  await retrying(page);
  await send(page).click();
  await toast(page, /^Not sent to Rae yet\. The mail server refused it: 554/).waitFor({
    timeout: 30_000,
  });
  await readsAcross(page, /^Not sent to Rae yet\./);
  await readable(page, 'phone-light-retrying');
  await page.unrouteAll();
  await toast(page, /^Couldn’t send to Rae\. The mail server refused it: 554/).waitFor({
    timeout: 30_000,
  });
  await readsAcross(page, /^Couldn’t send to Rae\./);
  await readable(page, 'phone-light-refused');
  await page.getByRole('button', { name: 'Open Outbox' }).click();
  const row = page.getByRole('listitem').filter({ hasText: /To Rae Holm/ });
  await row.getByText(/554 5\.4\.4 unreachable\.example can’t be reached right now/).waitFor();
  expect(await hasAirmail(page, /To Rae Holm/)).toBe(false);
  await readable(page, 'phone-light-failed');
  await row.getByRole('button', { name: 'Retry' }).click();
  await page.getByRole('heading', { name: 'Nothing is leaving' }).waitFor({ timeout: 30_000 });
}, 60_000);

test('a send later says when on a phone, across its toast, and Undo keeps the draft', async () => {
  const page = await open({ ...PHONE, colorScheme: 'dark' });
  await openDraft(page, /Offsite agenda/);
  await page.getByRole('button', { name: 'Send later' }).filter({ visible: true }).click();
  await page
    .getByRole('menuitem', { name: /morning$/ })
    .first()
    .click();
  const scheduled = /^Sending to Sofia and 2 others /;
  // Once the list has slid back into view and the toast into place.
  await page.getByRole('heading', { name: 'Drafts' }).first().click({ trial: true });
  await toast(page, scheduled).click({ trial: true });
  await readsAcross(page, scheduled);
  await readable(page, 'phone-dark-scheduled');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await toast(page, /^Undone\. Nothing was sent to Sofia and 2 others\.$/).waitFor();
}, 60_000);

test('a send at a picked time waits for it in the Outbox, under airmail', async () => {
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
}, 60_000);
