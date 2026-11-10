import { expect } from 'bun:test';
import { ICONS } from '../../src/app/icons.ts';
import { suite } from './suite.ts';

/**
 * Installing Trail Mix: Chromium finds nothing that stops it, and the manifest and icons it asks
 * for arrive with the member's cookie, since Cloudflare Access answers a request without it with
 * its sign-in page.
 */

const app = suite();
const { test } = app;

test('Chromium can install Trail Mix, and asks for its manifest with the member’s cookie', async () => {
  const context = await app.context();
  await context.addCookies([{ name: 'CF_Authorization', value: 'member', url: app.url }]);
  const page = await context.newPage();
  const asked = page.waitForRequest(/\/manifest\.webmanifest$/);
  await page.goto(app.url, { waitUntil: 'networkidle' });
  const browser = await context.newCDPSession(page);

  const { errors } = await browser.send('Page.getAppManifest');
  const { installabilityErrors } = await browser.send('Page.getInstallabilityErrors');
  expect({ errors, installabilityErrors }).toEqual({ errors: [], installabilityErrors: [] });
  expect((await (await asked).allHeaders())['cookie']).toContain('CF_Authorization=member');
  await context.close();
});

test('every icon is a PNG at its size, the touch icon included', async () => {
  const context = await app.context();
  const page = await context.newPage();
  await page.goto(app.url, { waitUntil: 'load' });
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(touch).toBe('/icons/apple-touch-icon.png');
  for (const { file, size } of ICONS) {
    const response = await page.request.get(new URL(`/icons/${file}`, app.url).href);
    const header = new DataView((await response.body()).buffer);
    expect({
      file,
      type: response.headers()['content-type'],
      width: header.getUint32(16),
      height: header.getUint32(20),
    }).toEqual({ file, type: 'image/png', width: size, height: size });
  }
  await context.close();
});
