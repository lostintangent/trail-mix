import { expect } from 'bun:test';
import { join } from 'node:path';
import { chromium, webkit, type Locator, type Page, type Route } from 'playwright';
import { SAVE_AFTER_MS, SAVE_AT_LEAST_EVERY_MS } from '../../src/features/composer/core/session.ts';
import { expectUsable, unusable } from './usable.ts';
import { chipsIn, goTo, reader } from './helpers.ts';
import { RESULTS, SIZES, suite } from './suite.ts';
import { atRest } from '../atRest.ts';
import { until } from '../until.ts';

/**
 * Writing, end to end: the built app on workerd with a member's demo mail. What the member writes
 * is saved to the account's Drafts as it goes, so a tab closed mid-sentence loses at most the last
 * few seconds, and a draft opened again comes back as it was written.
 *
 * It runs in Chromium at a desktop size, and in WebKit at a phone's, where the composer is a sheet
 * and contenteditable has the most quirks: `E2E_ENGINE=webkit E2E_SIZE=phone`.
 */

const MEMBER = `composer-${Date.now()}@trailmix.test`;
const IS_PHONE = process.env.E2E_SIZE === 'phone';
const SIZE = IS_PHONE ? SIZES.phone : SIZES.desktop;
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? webkit : chromium;

const app = suite({ vars: { DEV_MEMBER: MEMBER }, engine: ENGINE });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

const saved = (page: Page) => page.getByRole('status').filter({ hasText: 'Saved to Drafts' });

/** The composer by its name, whether it lies on the page or rises as a phone's sheet. */
const composerNamed = (page: Page, name: 'Reply' | 'Forward' | 'New message') =>
  page.locator(`section[aria-label="${name}"]`);

/** What a field says of itself beyond its name and value, as a screen reader hears it. */
const describedAs = (field: Locator) =>
  field.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  );

/** The reader's Reply to the newest message: on its own sheet on a desktop, in the island on a phone. */
const replyButton = (page: Page) =>
  reader(page).getByRole('button', { name: 'Reply', exact: true }).filter({ visible: true }).last();

/**
 * Leaves the composer, which keeps what was written in Drafts: by Escape on a desktop, which has no
 * Close, and by the Close of a phone's sheet.
 */
async function leave(page: Page, composer: Locator) {
  if (IS_PHONE) await composer.getByRole('button', { name: 'Close' }).click();
  else await page.keyboard.press('Escape');
  await composer.waitFor({ state: 'detached' });
}

test('a reply is saved as it is written, opens again with its words and files, and discards', async () => {
  const page = await app.open(SIZE);
  await page.getByRole('option').first().click();
  await replyButton(page).click();
  const composer = composerNamed(page, 'Reply');
  const text = composer.getByRole('textbox', { name: 'Reply' });
  await expect(text.evaluate((node) => node === document.activeElement)).resolves.toBe(true);

  await page.keyboard.type('See you **Thursday** at noon.');
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'agenda.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1. Lunch\n2. The engine\n'),
  });
  await composer.getByText('agenda.txt').waitFor();
  await saved(page).waitFor({ timeout: 10_000 });
  await page.screenshot({
    path: join(RESULTS, `composer-${ENGINE.name()}-${IS_PHONE ? 'phone' : 'desktop'}.png`),
  });
  await leave(page, composer);

  // The draft joins its conversation once the Mailroom has synced Drafts, folded like a message.
  const draft = reader(page).getByRole('button', { name: /^Draft/ });
  await draft.waitFor({ timeout: 10_000 });
  await draft.click();
  const reopened = composerNamed(page, 'Reply');
  const words = reopened.getByRole('textbox', { name: 'Reply' });
  await expect(words.locator('strong').textContent()).resolves.toBe('Thursday');
  await expect(words.textContent()).resolves.toBe('See you Thursday at noon.');
  await expect(reopened.getByRole('list', { name: 'Attachments' }).textContent()).resolves.toMatch(
    /^agenda\.txt/,
  );
  // While it is written again, the draft it came from stays out of the conversation.
  await expect(draft.count()).resolves.toBe(0);

  // A discard the Mailroom refuses leaves the draft where it was, so its line comes back.
  const refused = (route: Route) =>
    route.request().postData()?.includes('"move"') ? route.abort('failed') : route.fallback();
  await page.route('**/_serverFn/**', refused);
  await reopened.getByRole('button', { name: 'Discard draft' }).click();
  const toasts = page.getByRole('region', { name: 'Notifications' });
  await toasts.getByText('Couldn’t discard the draft. It is still in Drafts.').waitFor();
  await draft.click();
  await page.unroute('**/_serverFn/**', refused);

  // Discarding it moves it to the Trash, and the conversation leaves it out from the press, not
  // only once the Mailroom has synced the move.
  const synced = page.waitForResponse(
    async (response) =>
      decodeURIComponent(response.url()).includes('"conversation"') &&
      !(await response.text()).includes('See you Thursday'),
  );
  await reader(page).evaluate((reader) => {
    new MutationObserver(() => {
      const lines = Array.from(reader.querySelectorAll('button'), (line) => line.textContent);
      if (lines.some((line) => line.startsWith('Draft'))) Object.assign(window, { isBack: true });
    }).observe(reader, { subtree: true, childList: true, characterData: true });
  });
  await reopened.getByRole('button', { name: 'Discard draft' }).click();
  await toasts.getByText('Draft discarded').waitFor();
  await synced;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.evaluate(() => 'isBack' in window)).resolves.toBe(false);
}, 60_000);

test('a forward carries the original and its files under the note, opens again with only the note, and folds once sent', async () => {
  const page = await app.open(SIZE);
  await page.getByRole('option').filter({ hasText: 'Trip photos' }).first().click();
  await reader(page).getByRole('heading', { level: 1, name: 'Trip photos' }).waitFor();
  // By F on a desktop, and from the message's own menu on a phone, which has no keys.
  if (IS_PHONE) {
    await reader(page).getByRole('button', { name: 'More for this message' }).last().click();
    await page.getByRole('menuitem', { name: 'Forward' }).click();
  } else {
    await page.keyboard.press('f');
  }
  const composer = composerNamed(page, 'Forward');
  const to = composer.getByRole('combobox', { name: 'To' });
  await until(() => to.evaluate((field) => field === document.activeElement), 10_000);
  await expectForward(composer);
  await page.screenshot({
    path: join(RESULTS, `composer-forward-${ENGINE.name()}-${IS_PHONE ? 'phone' : 'desktop'}.png`),
  });
  await expect(unusable(page)).resolves.toEqual([]);
  await to.fill('theo@example.com');
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('The ridge, at last.');
  await saved(page).waitFor({ timeout: 10_000 });
  await leave(page, composer);

  // Its draft joins the original's conversation, and gives back only what the member wrote.
  await reader(page)
    .getByRole('button', { name: /^Draft/ })
    .click({ timeout: 10_000 });
  await expect(
    composer.getByRole('textbox', { name: 'Message' }).textContent({ timeout: 10_000 }),
  ).resolves.toBe('The ridge, at last.');
  await expectForward(composer);
  await page.keyboard.press('ControlOrMeta+Enter');
  await composer.waitFor({ state: 'detached' });

  // Opened, the server's copy shows the note, and folds the original the conversation already
  // shows.
  await reader(page)
    .getByRole('button', { name: /^You The ridge, at last\./ })
    .click({ timeout: 60_000 });
  const copy = reader(page).getByRole('article').last();
  const body = copy.locator('iframe').contentFrame().locator('body');
  await until(async () => (await body.innerText().catch(() => '')).includes('The ridge'), 10_000);
  expect(await body.innerText()).not.toContain('Forwarded message');
  // What went names the message it forwards, and carries its header block and both its pictures.
  await copy.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'View source' }).click();
  const source = page.getByRole('dialog');
  await source.getByText('Loading the source…').waitFor({ state: 'detached' });
  const header = (name: string) =>
    source
      .locator('dt', { hasText: new RegExp(`^${name}$`, 'i') })
      .locator('xpath=following-sibling::dd[1]');
  await expect(header('Subject').textContent()).resolves.toBe('Fwd: Trip photos');
  await expect(header('X-Forwarded-Message-Id').textContent()).resolves.toMatch(/^<.+>$/);
  const raw = await source.getByLabel('Raw source').textContent();
  for (const said of ['---------- Forwarded message ---------', 'lake.png', 'ridge.png']) {
    expect(raw).toContain(said);
  }
}, 120_000);

/**
 * Checks a forward of Trip photos is to its new Subject and names its original on a card, with the
 * original's attachment to remove and none of the pictures its HTML shows.
 */
async function expectForward(composer: Locator) {
  await expect(composer.getByRole('textbox', { name: 'Subject' }).inputValue()).resolves.toBe(
    'Fwd: Trip photos',
  );
  const card = composer.getByRole('region', { name: 'Forwarded message' });
  await expect(card.textContent()).resolves.toContain('Trip photos');
  const files = await composer.getByRole('list', { name: 'Attachments' }).textContent();
  expect(files).toContain('lake.png');
  expect(files).not.toContain('ridge.png');
}

test('pasted HTML brings no remote image, which never loads, even as the composer closes', async () => {
  const page = await app.open(SIZE);
  const tracked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracker.example')) tracked.push(request.url());
  });
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  const text = composer.getByRole('textbox', { name: 'Message' });
  await text.click();
  const saved = page.waitForResponse((response) =>
    Boolean(response.request().postData()?.includes('saveDraft')),
  );
  await page.evaluate(() => {
    const pasted = new DataTransfer();
    pasted.setData(
      'text/html',
      '<p>Pasted <b>words</b><img src="https://tracker.example/pixel.png" alt="pixel"></p>',
    );
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
    );
  });
  await text.locator('strong').waitFor();
  await expect(text.locator('img').count()).resolves.toBe(0);
  await leave(page, composer);
  await saved;
  expect(tracked).toEqual([]);
}, 60_000);

/** A 4 by 3 pixel PNG, pasted into the editor as a browser hands a pasted file to the page. */
async function pasteImage(page: Page) {
  await page.evaluate(() => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGElEQVR4nGOQ91/86aA3hGSAs4AkA7IMAGQcEltTdKHYAAAAAElFTkSuQmCC';
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    const pasted = new DataTransfer();
    pasted.items.add(new File([bytes], 'chart.png', { type: 'image/png' }));
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
    );
  });
}

/** The size of an image once it shows from where its `src` starts with `from`. */
async function shown(image: Locator, from: 'blob:' | '/messages/') {
  await image.and(image.page().locator(`img[src^="${from}"]`)).waitFor({ timeout: 10_000 });
  return image.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
}

test('a pasted image shows as it is pasted, once saved, after Undo of a send that carried changes, and when its draft opens again', async () => {
  const page = await app.open(SIZE);
  // The page itself never asks for a `cid:` address, which only the draft can answer.
  const asked: string[] = [];
  page.on('request', (request) => {
    if (/^cid:/i.test(request.url())) asked.push(request.url());
  });
  // A conversation of its own, where the third and fourth rows are the demo's GitHub bundles.
  await page.getByRole('option').nth(1).click();
  await replyButton(page).click();
  const reply = composerNamed(page, 'Reply');
  const text = reply.getByRole('textbox', { name: 'Reply' });
  await text.waitFor();
  await page.keyboard.type('The chart: ');
  await pasteImage(page);

  // From the pasted bytes until the draft holds them, and from the draft once it does.
  const image = text.locator('img');
  await expect(shown(image, 'blob:')).resolves.toEqual([4, 3]);
  // What is typed next goes on the line after it, rather than in its place.
  await page.keyboard.type('Up and to the right.');
  await expect(
    text
      .locator('img + p')
      .filter({ hasText: /^Up and to the right\.$/ })
      .count(),
  ).resolves.toBe(1);
  await reply.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'agenda.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1. Lunch\n2. The engine\n'),
  });
  await saved(page).waitFor({ timeout: 10_000 });
  await expect(shown(image, '/messages/')).resolves.toEqual([4, 3]);
  const before = (await image.getAttribute('src'))!;

  // Sent before the change saves, so Send carries it, and the draft it is filed as replaces the one
  // the files were named by.
  await page.keyboard.type(' Bring the map.');
  const carried = page.waitForRequest((request) => {
    const asked = request.postData() ?? '';
    return asked.includes('"send"') && asked.includes('Bring the map.');
  });
  await page.keyboard.press('ControlOrMeta+Enter');
  await reply.waitFor({ state: 'detached' });
  await carried;
  const line = reader(page).locator('div:has(> [data-airmail])', { hasText: 'Bring the map.' });
  await line.getByText(/^Sending in \d+s$/).waitFor();
  await line.getByRole('button', { name: 'Undo' }).click();
  await expect(text.textContent({ timeout: 10_000 })).resolves.toContain('Bring the map.');

  // The files are named by the draft the send filed, and still show and save once the Mailroom has
  // let the replaced draft's bytes go.
  await image
    .and(page.locator(`img[src^="/messages/"]:not([src="${before}"])`))
    .waitFor({ timeout: 10_000 });
  const isGone = () =>
    page.evaluate(async (was) => !(await fetch(was, { cache: 'no-store' })).ok, before);
  for (const by = Date.now() + 30_000; !(await isGone()); await page.waitForTimeout(500)) {
    if (Date.now() > by) throw new Error('The replaced draft’s bytes are still kept.');
  }
  await expect(shown(image, '/messages/')).resolves.toEqual([4, 3]);
  const saving = page.waitForResponse((response) =>
    Boolean(response.request().postData()?.includes('saveDraft')),
  );
  await text.getByText('Bring the map.').click();
  await page.keyboard.type(' Again.');
  await expect((await saving).text()).resolves.not.toContain('"error"');
  await saved(page).waitFor({ timeout: 10_000 });
  await expect(reply.getByRole('list', { name: 'Attachments' }).textContent()).resolves.toMatch(
    /^agenda\.txt/,
  );
  await leave(page, reply);

  const draft = reader(page).getByRole('button', { name: /^Draft/ });
  await draft.waitFor({ timeout: 10_000 });
  await draft.click();
  await expect(shown(image, '/messages/')).resolves.toEqual([4, 3]);
  await reply.getByRole('button', { name: 'Discard draft' }).click();
  await reply.waitFor({ state: 'detached' });
  expect(asked).toEqual([]);
}, 90_000);

test('a new message sent counts down in a toast, since it has no conversation on screen', async () => {
  const page = await app.open(SIZE);
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await composer.getByRole('combobox', { name: 'To' }).fill('sam@trailmix.test');
  await composer.getByRole('textbox', { name: 'Subject' }).fill('Trailhead at eight');
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Bring the map.');
  await saved(page).waitFor({ timeout: 10_000 });
  await page.keyboard.press('ControlOrMeta+Enter');
  await composer.waitFor({ state: 'detached' });

  const notifications = page.getByRole('region', { name: 'Notifications' });
  await notifications.getByText(/^Sending to \S+ in \d+s$/).waitFor();
  await notifications.getByRole('button', { name: 'Undo' }).click();
  await expect(
    composer.getByRole('textbox', { name: 'Message' }).textContent({ timeout: 10_000 }),
  ).resolves.toBe('Bring the map.');
}, 60_000);

test('To completes from the people in the mail, by keys on a desktop and by a tap on a phone', async () => {
  const page = await app.open(SIZE);
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  const to = composer.getByRole('combobox', { name: 'To' });
  const people = page.getByRole('listbox', { name: 'People' });
  const person = (name: string) => people.getByRole('option', { name: new RegExp(`^${name}`) });
  await to.click();

  await page.keyboard.type('the');
  await person('Theo Lindqvist').waitFor();
  await expect(to.getAttribute('aria-expanded')).resolves.toBe('true');
  if (IS_PHONE) {
    // A tap picks a person and leaves the keyboard up.
    await person('Theo Lindqvist').tap();
  } else {
    await page.keyboard.press('Enter');
  }
  await people.waitFor({ state: 'hidden' });
  await expect(chipsIn(composer, 'To')).resolves.toEqual(['Theo Lindqvist, theo@example.com']);
  await expect(to.inputValue()).resolves.toBe('');

  // What's typed next completes the next address, and the list reads, and on a phone every person
  // is a finger's target, in both themes.
  await page.keyboard.type('pri');
  await person('Priya Raman').waitFor();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    // A theme changes over 125 ms, and a screen read mid-change has colors from both.
    await atRest(page);
    expect({ colorScheme, unusable: await unusable(page) }).toEqual({
      colorScheme,
      unusable: [],
    });
  }
  if (IS_PHONE) {
    await person('Priya Raman').tap();
  } else {
    // Escape closes the list and leaves the composer open, and typing on opens it again.
    await page.keyboard.press('Escape');
    await people.waitFor({ state: 'hidden' });
    await page.keyboard.type('y');
    await person('Priya Raman').waitFor();
    // Tab picks too, and keeps the focus in the field for the next.
    await page.keyboard.press('Tab');
  }
  await expect(chipsIn(composer, 'To')).resolves.toEqual([
    'Theo Lindqvist, theo@example.com',
    'Priya Raman, priya@example.com',
  ]);
  await expect(to.evaluate((field) => field === document.activeElement)).resolves.toBe(true);
}, 60_000);

test('To holds each address as a chip, which Backspace or its button removes, and Send refuses text', async () => {
  const page = await app.open(SIZE);
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  const to = composer.getByRole('combobox', { name: 'To' });
  const chips = () => chipsIn(composer, 'To');
  await to.click();

  // A comma ends an address, and a paste of several makes a chip of each.
  await page.keyboard.type('ari@example.com,');
  await expect(chips()).resolves.toEqual(['ari@example.com']);
  await page.evaluate(() => {
    const pasted = new DataTransfer();
    pasted.setData('text/plain', 'Rae Chen <rae@example.com>; sam@trailmix.test');
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
    );
  });
  await expect(chips()).resolves.toEqual([
    'ari@example.com',
    'Rae Chen, rae@example.com',
    'sam@trailmix.test',
  ]);
  await expect(to.inputValue()).resolves.toBe('');
  await expect(describedAs(to)).resolves.toBe('3 addresses');

  // Backspace at the field's start selects the last chip, and again removes it.
  await page.keyboard.press('Backspace');
  await expect(chips()).resolves.toHaveLength(3);
  await page.keyboard.press('Backspace');
  await expect(chips()).resolves.toEqual(['ari@example.com', 'Rae Chen, rae@example.com']);
  // Its button removes a chip by a click or a tap, and leaves the focus in the field.
  await composer.getByRole('button', { name: 'Remove ari@example.com' }).click();
  await expect(chips()).resolves.toEqual(['Rae Chen, rae@example.com']);
  await expect(to.evaluate((field) => field === document.activeElement)).resolves.toBe(true);

  // Text that names no address is a chip in red, which Send refuses, saying which, and selects.
  await page.keyboard.type('the ridge crew');
  await page.keyboard.press('Enter');
  await expect(chips()).resolves.toEqual([
    'Rae Chen, rae@example.com',
    'the ridge crew, Not an address',
  ]);
  await expect(describedAs(to)).resolves.toBe('1 address, 1 not an address');
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Bring the map.');
  // The refusal reads whole under its field, on the narrowest phone too.
  if (IS_PHONE) await page.setViewportSize({ width: 320, height: 640 });
  await page.keyboard.press('ControlOrMeta+Enter');
  const refusal = composer.getByText('“the ridge crew” isn’t an address');
  await refusal.waitFor();
  await expect(
    refusal.evaluate(
      (line) =>
        line.scrollWidth <= line.clientWidth &&
        line.getBoundingClientRect().right <= document.documentElement.clientWidth,
    ),
  ).resolves.toBe(true);
  await expect(to.evaluate((field) => field === document.activeElement)).resolves.toBe(true);
  await expect(describedAs(to)).resolves.toBe(
    '“the ridge crew” isn’t an address 1 address, 1 not an address',
  );
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expectUsable(
      page,
      `composer-${ENGINE.name()}-${IS_PHONE ? 'phone' : 'desktop'}-${colorScheme}-refused`,
    );
  }
  await page.keyboard.press('Backspace');
  await expect(chips()).resolves.toEqual(['Rae Chen, rae@example.com']);
  await refusal.waitFor({ state: 'detached' });
  await expect(describedAs(to)).resolves.toBe('1 address');

  // Sent and undone, the message comes back to the same chips.
  await page.keyboard.press('ControlOrMeta+Enter');
  await composer.waitFor({ state: 'detached' });
  await page
    .getByRole('region', { name: 'Notifications' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await composer.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: 10_000 });
  await expect(chips()).resolves.toEqual(['Rae Chen, rae@example.com']);
}, 60_000);

test('Link turns the selected words into a link, adding https to an address typed without it', async () => {
  const page = await app.open(SIZE);
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('the plan');
  // Select the words by arrow keys, which every platform reads alike. Ctrl+A on Linux reaches a
  // touch WebKit as iOS's Ctrl+A, which moves to the start of the line.
  for (let at = 0; at < 'the plan'.length; at++) await page.keyboard.press('Shift+ArrowLeft');
  await composer.getByRole('button', { name: 'Link', exact: true }).click();
  // The words chosen as Link was pressed are the ones it links, even once the selection has moved,
  // as Safari moves it when the focus goes to the address.
  await composer.getByRole('textbox', { name: 'Message' }).press('ArrowRight');
  await composer.getByRole('textbox', { name: 'Link address' }).fill('example.com/plan');
  await page.keyboard.press('Enter');
  const link = composer.getByRole('textbox', { name: 'Message' }).getByRole('link');
  await expect(link.getAttribute('href')).resolves.toBe('https://example.com/plan');
  await expect(link.textContent()).resolves.toBe('the plan');
  // Pressed while the cursor is in a link, Link takes it away again.
  await composer.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(link.count()).resolves.toBe(0);
}, 60_000);

test('a draft another client wrote as HTML opens with its words, and closed untouched stays as it was', async () => {
  const page = await app.open(SIZE);
  // Every command this browser sends, by name, to find any that could change the draft.
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') sent.push(request.postData() ?? '');
  });
  await goTo(page, 'Drafts');
  await page.getByRole('option').filter({ hasText: 'Offsite agenda' }).click();
  const line = reader(page).getByRole('button', { name: /^Draft/ });
  await line.click();

  const words = composerNamed(page, 'New message').getByRole('textbox', { name: 'Message' });
  await words.getByRole('listitem').first().waitFor();
  await expect(words.textContent()).resolves.toBe(
    'Draft agenda for the offsite:Morning: walk through the planLunchAfternoon: review the mobile layout',
  );
  await expect(words.locator('strong').textContent()).resolves.toBe('offsite');
  await expect(words.locator('em').textContent()).resolves.toBe('mobile layout');
  await expect(words.getByRole('link').getAttribute('href')).resolves.toBe(
    'https://example.org/plan',
  );
  await expect(words.getByRole('listitem').count()).resolves.toBe(3);

  await leave(page, composerNamed(page, 'New message'));
  // Nothing shows a save that never came, so this waits past when one would have.
  await page.waitForTimeout(SAVE_AFTER_MS + 1_000);
  expect(sent.filter((body) => /saveDraft|"move"/.test(body))).toEqual([]);
  await line.waitFor();
}, 60_000);

// A phone's sheet lies over everything and leaves by its Close.
if (!IS_PHONE) {
  test('a desktop leaves a reply for another conversation, and a new message for another view or by Escape, keeping each', async () => {
    const page = await app.open(SIZE);
    const row = (subject: string) => page.getByRole('option').filter({ hasText: subject });
    await row('Design review notes').click();
    await replyButton(page).click();
    const reply = composerNamed(page, 'Reply');
    await reply.getByRole('textbox', { name: 'Reply' }).waitFor();
    await page.keyboard.type('Left for another conversation.');
    await row('Trip photos').click();
    await reply.waitFor({ state: 'detached' });
    await row('Design review notes').click();
    await reader(page)
      .getByRole('button', { name: /^Draft/ })
      .filter({ hasText: 'Left for another conversation.' })
      .waitFor({ timeout: 10_000 });

    // From the Outbox, which opens no conversation, so the new message belongs to none.
    const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
    await sidebar.getByRole('button', { name: /^Outbox/ }).click();
    const forView = `Left for a view ${Date.now()}`;
    const forEscape = `Left by Escape ${Date.now()}`;
    const written = composerNamed(page, 'New message');
    for (const [subject, leaveIt] of [
      [
        forView,
        () =>
          sidebar
            .getByRole('button', { name: /^Inbox/ })
            .first()
            .click(),
      ],
      [forEscape, () => page.keyboard.press('Escape')],
    ] as const) {
      await page.keyboard.press('c');
      await written.getByRole('textbox', { name: 'Subject' }).fill(subject);
      await written.getByRole('textbox', { name: 'Message' }).click();
      await page.keyboard.type('Bring the map.');
      await leaveIt();
      await written.waitFor({ state: 'detached' });
    }
    await goTo(page, 'Drafts');
    await row(forView).waitFor({ timeout: 10_000 });
    await row(forEscape).waitFor({ timeout: 10_000 });
  }, 60_000);
}

test('a tab closed mid-sentence keeps all but the last few seconds of what was written', async () => {
  const page = await app.open(SIZE);
  const subject = `Mid-sentence ${Date.now()}`;
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await page.keyboard.type('grace@example.com');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await composer.getByRole('textbox', { name: 'Message' }).click();

  // Words go in steadily, with no pause long enough to save after, until the tab closes.
  const typed: { word: string; at: number }[] = [];
  const until = performance.now() + SAVE_AT_LEAST_EVERY_MS * 2.5;
  for (let at = 0; performance.now() < until; at++) {
    const word = `w${at}`;
    await page.keyboard.type(`${word} `);
    typed.push({ word, at: performance.now() });
    await page.waitForTimeout(100);
  }
  // At worst, the network goes with the tab, so the save the page makes as it hides never lands.
  const closedAt = performance.now();
  await page.context().setOffline(true);
  await page.close();

  const again = await app.open(SIZE);
  await goTo(again, 'Drafts');
  await again.getByRole('option').filter({ hasText: subject }).click();
  await reader(again)
    .getByRole('button', { name: /^Draft/ })
    .click();
  const kept = await composerNamed(again, 'New message')
    .getByRole('textbox', { name: 'Message' })
    .textContent();
  const words = new Set(kept?.split(/\s+/));
  // A save starts at least that often while typing goes on, and takes a moment to land.
  const mustKeep = typed.filter(({ at }) => at < closedAt - SAVE_AT_LEAST_EVERY_MS - 1_000);
  expect(mustKeep.length).toBeGreaterThan(10);
  expect(mustKeep.filter(({ word }) => !words.has(word))).toEqual([]);
}, 60_000);

test('a save whose answer was lost is asked again under its id, and Drafts keeps one copy with every word', async () => {
  const page = await app.open(SIZE);
  const subject = `Unanswered ${Date.now()}`;
  // The Mailroom files the first save, and its answer is lost on the way back.
  const lost = Promise.withResolvers<void>();
  let asks = 0;
  await page.route('**/_serverFn/**', async (route) => {
    if (!route.request().postData()?.includes('saveDraft') || asks++ > 0) return route.fallback();
    await route.fetch();
    await route.abort('failed');
    lost.resolve();
  });
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await page.keyboard.type('grace@example.com');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Written before.');
  await lost.promise;
  // What's written while it's asked again saves once it's answered.
  await page.keyboard.type(' And while.');
  await saved(page).waitFor({ timeout: 15_000 });
  await leave(page, composer);

  await goTo(page, 'Drafts');
  const rows = page.getByRole('option').filter({ hasText: subject });
  await rows.first().click();
  const drafts = reader(page).getByRole('button', { name: /^Draft/ });
  await drafts.filter({ hasText: 'Written before. And while.' }).waitFor({ timeout: 10_000 });
  await rows.nth(1).waitFor({ state: 'detached' });
  await drafts.nth(1).waitFor({ state: 'detached' });
  expect(asks).toBeGreaterThan(1);
}, 60_000);
