// The demo mailbox, read through the real Mailroom on the local Workers runtime: every body renders
// in the reader's frame with nothing run or loaded, and every message's bytes come back over the
// Mailroom's stub as the app's routes serve them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import type {
  Account,
  Body,
  ConversationSummary,
  Message,
  MessageRef,
} from '../../src/features/mail/core/index.ts';
import type { Page } from '../../src/features/mailroom/client/index.ts';
import { messageUrl, partUrl } from '../../src/features/mailroom/client/urls.ts';
import { startWorker, type LocalWorker } from '../workerd.ts';
import { BROWSERS, launch, serveHarness, type Harness } from './browsers.ts';

/** The newest conversations of the demo's unified Inbox, which hold every kind of mail it has. */
const NEWEST = 40;

let worker: LocalWorker;
let harness: Harness;
let mail: { message: Message; body: Body }[];

beforeAll(async () => {
  worker = await startWorker({
    name: 'trail-mix-reader-test',
    main: join(import.meta.dir, 'worker.ts'),
    durable_objects: { bindings: [{ name: 'MAILROOM', class_name: 'TestMailroom' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['TestMailroom'] }],
    r2_buckets: [{ binding: 'BODIES', bucket_name: 'bodies' }],
    vars: { CREDENTIALS_KEY: 'a-test-key-that-is-at-least-32-characters', DEMO_MAILBOX: '200' },
  });
  harness = await serveHarness();
  await until(async () => (await call<Account[]>('accounts')).every((a) => a.status === 'ready'));
  const { items } = await call<Page>('conversations', { in: 'inbox' });
  const newest = await Promise.all(
    items.slice(0, NEWEST).map(async ({ id }: ConversationSummary) => {
      const thread = await call<Message[]>('conversation', id);
      return thread.toSorted((a, b) => a.date.localeCompare(b.date)).at(-1)!;
    }),
  );
  mail = await Promise.all(
    newest.map(async (message) => ({ message, body: await call<Body>('body', refOf(message)) })),
  );
}, 120_000);

afterAll(() => {
  worker?.stop();
  harness?.stop();
});

test('the demo’s newest mail includes HTML, attachments and inline images', () => {
  expect(mail.length).toBe(NEWEST);
  expect(mail.filter(({ body }) => body.html !== undefined).length).toBeGreaterThan(5);
  expect(mail.some(({ body }) => body.attachments.some(({ contentId }) => !contentId))).toBe(true);
  expect(mail.some(({ body }) => body.html && body.html.length > 250_000)).toBe(true);
});

describe('a message’s bytes, over the Mailroom’s stub', () => {
  test('the source is the message as received, served so it cannot run', async () => {
    const { message } = mail[0]!;
    const response = await bytes(messageUrl(message));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toStartWith('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain(message.messageId);
  });

  test('every part is its whole size, and only raster images show inline', async () => {
    const parts = mail.flatMap(({ message, body }) =>
      body.attachments.map((attachment) => ({ message, attachment })),
    );
    expect(parts.length).toBeGreaterThan(0);
    for (const { message, attachment } of parts) {
      const response = await bytes(partUrl(message, attachment.id));
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(attachment.size);
      const inline = /^image\/(png|jpeg|gif|webp)$/.test(attachment.type);
      expect(response.headers.get('content-disposition')).toStartWith(
        inline ? 'inline;' : 'attachment;',
      );
    }
  });

  test('a part the message does not have is not found', async () => {
    expect((await bytes(partUrl(mail[0]!.message, '999'))).status).toBe(404);
  });
});

for (const type of BROWSERS) {
  describe(`${type.name()}, the demo’s newest mail`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await launch(type);
    }, 30_000);
    afterAll(() => browser.close());

    test('renders with nothing run and nothing loaded before images are allowed', async () => {
      const page = await browser.newPage();
      const elsewhere: string[] = [];
      page.on('request', (request) => {
        const url = request.url();
        if (/^(https?|wss?):/.test(url) && !url.startsWith(harness.origin)) elsewhere.push(url);
      });
      await page.goto(harness.origin);
      const html = mail.flatMap(({ body }) => (body.html === undefined ? [] : [body.html]));
      await page.evaluate(
        (shown) => window.show(shown.map((each) => ({ html: each, images: 'blocked' as const }))),
        html,
      );
      await page.waitForFunction(
        (count) =>
          [...document.querySelectorAll('iframe')].filter(
            (frame) => frame.style.visibility === 'visible',
          ).length === count,
        html.length,
      );
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => window.pwned)).toEqual([]);
      expect(elsewhere).toEqual([]);
      await page.close();
    }, 30_000);
  });
}

async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`${worker.url}/ada/call`, {
    method: 'POST',
    body: JSON.stringify({ name, args }),
  });
  const result = (await response.json()) as { value?: T; error?: string };
  if (result.error !== undefined) throw new Error(result.error);
  return result.value as T;
}

const bytes = (path: string) => fetch(`${worker.url}/ada${path}`);

const refOf = ({ account, path, uidValidity, uid }: MessageRef): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});

async function until(condition: () => Promise<boolean>, timeout = 60_000) {
  for (const start = Date.now(); !(await condition());) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for the Mailroom.');
    await Bun.sleep(100);
  }
}
