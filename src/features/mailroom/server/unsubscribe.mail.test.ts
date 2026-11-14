// One-click unsubscribe in the Mailroom on the local Workers runtime, against the test mail server,
// with a stand-in on this machine for the senders' servers: which mail offers it, exactly what the
// Mailroom posts and to whom, and what each answer means.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import type { Body, Message } from '../../mail/core/index.ts';
import type { Unsubscribed } from '../client/contract.ts';
import {
  caFile,
  deliver,
  empty,
  start,
  stop,
  users,
} from '../../../../tests/mail-server/server.ts';
import { mailrooms, member, setupOf } from '../../../../tests/mailrooms.ts';
import type { LocalWorker } from '../../../../tests/workerd.ts';

const { bob } = users;
/** The name the test mail server signs its Authentication-Results with, as a preset would give. */
const SIGNER = 'mx.trailmix.test';

/** What reached the senders' stand-in, in order. */
type Posted = { method: string; path: string; headers: Record<string, string>; body: string };
let senders: ReturnType<typeof Bun.serve>;
const posted: Posted[] = [];
/** How the stand-in answers at each path. */
const ANSWERS: Record<string, () => Response> = {
  '/taken': () => new Response('You are unsubscribed.'),
  '/gone': () => new Response('', { status: 404, statusText: 'Not Found' }),
  '/moved': () => Response.redirect(`${here}/taken`, 302),
};
let here: string;
let worker: LocalWorker;

beforeAll(async () => {
  await start('full');
  await empty(bob.email);
  const tls = dirname(caFile);
  senders = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { cert: Bun.file(join(tls, 'server.crt')), key: Bun.file(join(tls, 'server.key')) },
    async fetch(request) {
      const url = new URL(request.url);
      posted.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      return ANSWERS[url.pathname]?.() ?? new Response('', { status: 404 });
    },
  });
  here = `https://127.0.0.1:${senders.port}`;
  worker = await mailrooms({
    AUTH_SERVERS_STAND_IN: JSON.stringify({ localhost: [SIGNER] }),
    UNSUBSCRIBE_STAND_IN: here,
  });
  await deliver(
    bob.email,
    offering('taken', `${here}/taken?u=bob`),
    offering('gone', `${here}/gone`),
    offering('moved', `${here}/moved`),
    offering('private', 'https://10.1.2.3/unsubscribe'),
    offering('nowhere', 'https://unsubscribe.invalid/'),
    // The server found DMARC failed, and the sender wrote results of their own beneath that say it
    // passed, in the server's name.
    offering('forged', `${here}/taken?u=forged`, {
      dmarc: 'fail',
      below: [`Authentication-Results: ${SIGNER}; dkim=pass header.d=news.test; dmarc=pass`],
    }),
    // A signature that leaves the list's headers out, so anyone on the way could have added them.
    offering('unsigned', `${here}/taken?u=unsigned`, { signed: 'From:To:Subject' }),
  );
}, 120_000);

afterAll(async () => {
  worker?.stop();
  await senders?.stop(true);
  await stop();
});

describe('One-click unsubscribe', () => {
  const ada = member('ada', () => worker);
  let messages: Map<string, Message>;

  beforeAll(async () => {
    await ada.call('addAccount', setupOf(bob, 'Bob'));
    await ada.until(async () => (await ada.page({ in: 'inbox' })).length === 7);
    const rows = await ada.page({ in: 'inbox' });
    const opened = await Promise.all(
      rows.map(async (row) => (await ada.call<Message[]>('conversation', row.id))[0]!),
    );
    messages = new Map(opened.map((message) => [message.subject, message]));
  }, 60_000);

  const unsubscribe = (subject: string) =>
    ada.call<Unsubscribed>('unsubscribe', messages.get(subject));
  const offerOf = async (subject: string) =>
    (await ada.call<Body>('body', messages.get(subject))).unsubscribe;

  test('posts the form once, to the address alone, with nothing that names the member', async () => {
    expect(await offerOf('taken')).toBe(`${here}/taken?u=bob`);
    posted.length = 0;

    expect(await unsubscribe('taken')).toEqual({ taken: true });

    expect(posted).toEqual([
      {
        method: 'POST',
        path: '/taken?u=bob',
        headers: expect.objectContaining({
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': expect.stringMatching(/^TrailMix /) as string,
        }) as Record<string, string>,
        body: 'List-Unsubscribe=One-Click',
      },
    ]);
    expect(posted[0]!.headers).not.toContainAnyKeys(['cookie', 'authorization', 'referer']);
  });

  test('a sender that turns it away, or answers with a redirect, is named with why', async () => {
    posted.length = 0;
    const host = new URL(here).host;

    expect(await unsubscribe('gone')).toEqual({
      taken: false,
      reason: `${host} answered 404 Not Found.`,
    });
    expect(await unsubscribe('moved')).toEqual({
      taken: false,
      reason: `${host} answered with a redirect, which a one-click unsubscribe doesn’t follow.`,
    });
    // The redirect led back to an address that would take it, and the Mailroom didn't go there.
    expect(posted.map(({ path }) => path)).toEqual(['/gone', '/moved']);
  });

  test('a host on a private network is refused unasked, and one that can’t be reached says so', async () => {
    posted.length = 0;

    expect(await unsubscribe('private')).toEqual({
      taken: false,
      reason: 'Trail Mix unsubscribes only at public hosts over HTTPS.',
    });
    expect(await unsubscribe('nowhere')).toEqual({
      taken: false,
      reason: 'Trail Mix couldn’t reach unsubscribe.invalid.',
    });
    expect(posted).toEqual([]);
  });

  test('mail whose offer its server didn’t vouch for offers nothing, and asking posts nothing', async () => {
    posted.length = 0;

    for (const subject of ['forged', 'unsigned']) {
      expect(await offerOf(subject)).toBeUndefined();
      expect(await unsubscribe(subject)).toEqual({
        taken: false,
        reason: 'This message doesn’t offer to unsubscribe in one click.',
      });
    }
    expect(posted).toEqual([]);
  });
});

/**
 * A list's message to Bob offering one-click unsubscribe at `address`, signed by the sender over
 * the headers `signed` names, with the results Bob's server wrote on top and any below them.
 */
function offering(
  subject: string,
  address: string,
  {
    dmarc = 'pass',
    below = [],
    signed = 'From:To:Subject:Date:Message-ID:List-Unsubscribe:List-Unsubscribe-Post',
  }: { dmarc?: 'pass' | 'fail'; below?: string[]; signed?: string } = {},
) {
  return [
    `Authentication-Results: ${SIGNER};`,
    `\tdkim=${dmarc} header.d=news.test header.s=s1;`,
    `\tdmarc=${dmarc} (p=reject dis=none) header.from=news.test`,
    ...below,
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=news.test; s=s1;`,
    `\th=${signed}; bh=YmgK; b=c2lnbmF0dXJlCg==`,
    'From: News <news@news.test>',
    `To: ${bob.email}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${subject}@news.test>`,
    `List-Unsubscribe: <${address}>, <mailto:leave@news.test>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `This is ${subject}.`,
    '',
  ].join('\r\n');
}
