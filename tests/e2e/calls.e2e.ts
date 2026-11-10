import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { serverFunctionIds, startPreview, type Preview } from './preview.ts';

/**
 * The built Worker answering the browser's Mailroom, from Trail Mix's own page. A query travels as
 * a GET, and a command must never travel that way, since the Worker checks the origin of POSTs.
 * The calls reuse the app's own request for the accounts, so they're encoded as Start encodes them.
 */

const REFUSED = 'That isn’t something a browser can ask its Mailroom.';

let preview: Preview;
let browser: Browser;
let page: Page;
let accounts: string;

beforeAll(async () => {
  preview = await startPreview();
  browser = await chromium.launch();
  page = await browser.newPage();
  const asked = page.waitForRequest((request) =>
    request.url().includes(encodeURIComponent('"accounts"')),
  );
  await page.goto(preview.url);
  accounts = (await asked).url();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await preview?.stop();
});

/** What the Worker answers the page for a GET, as its status and text. */
const get = (url: string) =>
  page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { 'x-tsr-serverFn': 'true' } });
    return { status: response.status, text: await response.text() };
  }, url);

test('a command can’t travel as a GET, through either server function', async () => {
  const asCommand = accounts.replace(
    encodeURIComponent('"accounts"'),
    encodeURIComponent('"eraseEverything"'),
  );
  const commandFunction = new URL(`/_serverFn/${serverFunctionIds().command}`, preview.url).href;

  expect(await get(accounts)).toMatchObject({ status: 200 });
  expect((await get(asCommand)).text).toContain(REFUSED);
  expect(await get(commandFunction)).toMatchObject({ status: 405 });
});
