import { expect } from 'bun:test';
import type { Page } from 'playwright';
import { serverFunctionIds } from './preview.ts';
import { suite } from './suite.ts';

/**
 * The built Worker answering the browser's Mailroom, from Trail Mix's own page. A query travels as
 * a GET, and a command must never travel that way, since the Worker checks the origin of POSTs.
 * The calls reuse the app's own request for the accounts, so they're encoded as Start encodes them.
 */

const REFUSED = 'That isn’t something a browser can ask its Mailroom.';

const app = suite();
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

/** Trail Mix's page, and the app's own request for the accounts, which the calls reuse. */
async function trailMix(): Promise<{ page: Page; accounts: string }> {
  const page = await (await app.context()).newPage();
  const asked = page.waitForRequest((request) =>
    request.url().includes(encodeURIComponent('"accounts"')),
  );
  await page.goto(app.url);
  return { page, accounts: (await asked).url() };
}

/** What the Worker answers the page for a GET, as its status and text. */
const get = (page: Page, url: string) =>
  page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { 'x-tsr-serverFn': 'true' } });
    return { status: response.status, text: await response.text() };
  }, url);

test('a command can’t travel as a GET, through either server function', async () => {
  const { page, accounts } = await trailMix();
  const asCommand = accounts.replace(
    encodeURIComponent('"accounts"'),
    encodeURIComponent('"eraseEverything"'),
  );
  const commandFunction = new URL(`/_serverFn/${serverFunctionIds().command}`, app.url).href;

  expect(await get(page, accounts)).toMatchObject({ status: 200 });
  expect((await get(page, asCommand)).text).toContain(REFUSED);
  expect(await get(page, commandFunction)).toMatchObject({ status: 405 });
});

test('a query’s response says where its time went, in names and times alone', async () => {
  const page = await (await app.context()).newPage();
  const answered = page.waitForResponse((response) =>
    response.url().includes(encodeURIComponent('"accounts"')),
  );
  await page.goto(app.url);
  const timing = (await (await answered).allHeaders())['server-timing'] ?? '';
  const parts = timing.split(', ').map((part) => part.split(';')[0]);

  expect(parts.filter((name) => name !== 'isolate' && name !== 'cold')).toEqual([
    'access',
    'mailroom',
    'reached',
    'ran',
    'returned',
    'worker',
  ]);
  expect(timing).toContain('mailroom;dur=');
  expect(timing).toContain(';desc="accounts"');
  // Each part is a name, a time and at most a fixed note, so nothing the call carried shows.
  for (const part of timing.split(', ')) {
    expect(part).toMatch(/^[a-z]+(;dur=\d+(\.\d)?)?(;desc="(accounts|[A-Z][a-z ]+)")?$/);
  }
});
