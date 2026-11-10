import { expect, test } from 'bun:test';
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
