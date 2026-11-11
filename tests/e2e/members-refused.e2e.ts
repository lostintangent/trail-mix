import { afterAll, expect, test } from 'bun:test';
import { cloudflareStandIn, STAND_IN_AUD } from '../cloudflare-stand-in.ts';
import { serverFunctionIds } from './preview.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';

/**
 * Members as anyone but the operator meets it: not there at all, and its calls refused
 * with a 403 before they reach Cloudflare or anyone's Mailroom.
 */

const cloudflare = cloudflareStandIn({ members: ['operator@trailmix.test', 'bo@example.org'] });
const server = Bun.serve({ port: 0, fetch: (request) => cloudflare.handle(request) });
afterAll(() => server.stop(true));

const app = suite({
  vars: {
    DEV_MEMBER: `not-the-operator-${Date.now()}@trailmix.test`,
    OPERATOR_EMAIL: 'operator@trailmix.test',
    ACCESS_AUD: STAND_IN_AUD,
    CLOUDFLARE_ACCOUNT_ID: 'account',
    ACCESS_API_TOKEN: 'a-stand-in-token',
    CLOUDFLARE_API: `${server.url.origin}/client/v4`,
  },
});

test('anyone but the operator has no Members in Settings, and its calls are refused before Cloudflare', async () => {
  const page = await (await app.context({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(app.url);
  await mailIsIn(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('members');
  // The palette has drawn what matches by then, and the operator's command isn't among it.
  await page.waitForTimeout(1_000);
  expect(await page.getByRole('option', { name: 'Members' }).count()).toBe(0);
  await page.keyboard.press('Escape');
  // Settings has the member's own sections, and no Members.
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByRole('heading', { name: 'Appearance', level: 2 }).waitFor();
  expect(await settings.getByRole('heading', { name: 'Members' }).count()).toBe(0);

  // Naming someone to remove, as a page could, gets a 403 and reaches nothing.
  const status = await page.evaluate(async (url) => {
    const call = new FormData();
    call.set('call', JSON.stringify({ name: 'remove', args: ['bo@example.org', true] }));
    const response = await fetch(url, {
      method: 'POST',
      body: call,
      headers: { 'x-tsr-serverFn': 'true' },
    });
    return response.status;
  }, `/_serverFn/${serverFunctionIds().change}`);
  expect(status).toBe(403);
  expect(cloudflare.calls).toEqual([]);
  expect(cloudflare.members).toContain('bo@example.org');
}, 60_000);
