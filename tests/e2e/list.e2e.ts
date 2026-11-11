import { expect } from 'bun:test';
import { PAGE_SIZE } from '../../src/features/mailroom/client/contract.ts';
import { suite } from './suite.ts';

/**
 * A long list as it changes under the member: mail that arrives while it is scrolled down. Its own
 * member, since what it sends lands in the Inbox the other suites read.
 */

const app = suite({ vars: { DEV_MEMBER: `list-${Date.now()}@trailmix.test` } });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

/** The Inbox at a desktop's size, recording every error and failed response, to assert there were none. */
async function open() {
  const context = await app.context({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(app.url, { waitUntil: 'networkidle' });
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return { context, page, problems };
}

test('mail that arrives while the list is scrolled down moves nothing in sight, and leads it at the top', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  const length = async () =>
    Number(await list.getByRole('option').first().getAttribute('aria-setsize'));
  const before = await length();
  // Halfway down the Inbox, far past its first page, once the rows there have arrived.
  await list.evaluate((list) => (list.scrollTop = list.scrollHeight / 2));
  await page.waitForFunction((page) => {
    const list = document.querySelector('[role="listbox"][aria-multiselectable]');
    const first = Number(list?.querySelector('[role="option"]')?.getAttribute('aria-posinset'));
    return list?.getAttribute('aria-busy') === 'false' && first > page;
  }, PAGE_SIZE);
  const inSight = () =>
    list.evaluate((list) => {
      const top = list.getBoundingClientRect().top;
      return [...list.querySelectorAll('[role="option"]')].flatMap((row) => {
        const at = Math.round(row.getBoundingClientRect().top - top);
        return at >= 0 && at < list.clientHeight ? [`${at}: ${row.textContent}`] : [];
      });
    });
  const seen = await inSight();
  expect(seen.length).toBeGreaterThan(5);

  // The demo delivers what Sam sends Sam to Sam's Inbox once its send goes.
  const subject = `Arrived while scrolled down ${Date.now()}`;
  await page.keyboard.press('c');
  const composer = page.locator('section[aria-label="New message"]');
  await composer.getByRole('textbox', { name: 'To' }).fill('sam@trailmix.test');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await page.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
  await page.waitForFunction(
    (before) =>
      Number(document.querySelector('[role="option"]')?.getAttribute('aria-setsize')) > before,
    before,
    { timeout: 30_000 },
  );

  expect(await length()).toBe(before + 1);
  expect(await inSight()).toEqual(seen);
  await list.evaluate((list) => (list.scrollTop = 0));
  await list.getByRole('option').first().filter({ hasText: subject }).waitFor({ timeout: 5_000 });
  expect(problems).toEqual([]);
  await context.close();
}, 60_000);

test('a list dragged far down asks for no page on the way, only for where it stops', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  await list.getByRole('option').first().waitFor();
  // The places of the pages the list asks for, past its first.
  const asked: number[] = [];
  page.on('request', (request) => {
    const payload = decodeURIComponent(request.url());
    const at = /"s":"conversations".*?"t":0,"s":(\d+)/.exec(payload)?.[1];
    if (at && Number(at) > 0) asked.push(Number(at));
  });

  // A thumb dragged halfway down over half a second, the list moving a long way each frame.
  await list.evaluate(
    (list) =>
      new Promise<void>((resolve) => {
        let frame = 0;
        const step = () => {
          list.scrollTop = (list.scrollHeight / 2) * (++frame / 30);
          if (frame < 30) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
  );
  const onTheWay = asked.length;
  await page.waitForFunction(() => {
    const list = document.querySelector('[role="listbox"][aria-multiselectable]');
    return list?.getAttribute('aria-busy') === 'false' && list.querySelector('[role="option"]');
  });
  const first = Number(await list.getByRole('option').first().getAttribute('aria-posinset'));

  expect(onTheWay).toBe(0);
  // The pages in sight where it stopped, with the rows either side that arrive ahead.
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((at) => Math.abs(at - first) < 2 * PAGE_SIZE)).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('End selects the last conversation once its page arrives', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  const length = Number(await list.getByRole('option').first().getAttribute('aria-setsize'));
  expect(length).toBeGreaterThan(PAGE_SIZE);

  await list.focus();
  await page.keyboard.press('End');
  await list
    .locator(`[role="option"][aria-selected="true"][aria-posinset="${length}"]`)
    .waitFor({ timeout: 5_000 });
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);
