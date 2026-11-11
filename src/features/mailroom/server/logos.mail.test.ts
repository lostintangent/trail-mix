// Verified senders' logos in the Mailroom on the local Workers runtime, against the test mail
// server, with stand-ins on this machine for the server's signing name, DNS over HTTPS and the
// hosts that serve logos: which mail counts as verified, what the Logo cache keeps, how lists and
// conversations name a logo, how one found late reaches open devices, and how logos go.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ImapFlow } from 'imapflow';
import type { ConversationSummary, Message } from '../../mail/core/index.ts';
import type { AccountSetup } from '../client/contract.ts';
import { DEMO_LOGOS } from '../../providers/index.ts';
import { LOGO_BYTES } from '../core/logos.ts';
import { caFile, empty, ports, start, stop, users } from '../../../../tests/mail-server/server.ts';
import { mailrooms, member } from '../../../../tests/mailrooms.ts';
import type { LocalWorker } from '../../../../tests/workerd.ts';

const { bob } = users;
/** The name the test mail server signs its Authentication-Results with, as a preset would give. */
const SIGNER = 'mx.trailmix.test';
const LOGO = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 8 8"><title>Logo</title><rect width="8" height="8" fill="${color}"/></svg>`;

const setup = (host: string): AccountSetup => ({
  provider: 'imap',
  name: 'Bob',
  address: bob.email,
  imap: { host, port: ports.imaps, secure: true },
  smtp: { host, port: ports.submissions, secure: true },
  password: bob.password,
});

/** DNS and the logos' hosts, as the stand-in serves them, and every name and path asked of it. */
let internet: ReturnType<typeof Bun.serve>;
const asked: string[] = [];
let dns: Record<string, string[]> = {};
/** Held while a test keeps DNS from answering for a name, until it lets the answer go. */
const held = new Map<string, PromiseWithResolvers<void>>();

let ca: string;
let worker: LocalWorker;

beforeAll(async () => {
  await start('full');
  ca = readFileSync(caFile, 'utf8');
  await empty(bob.email);
  const tls = dirname(caFile);
  internet = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { cert: Bun.file(join(tls, 'server.crt')), key: Bun.file(join(tls, 'server.key')) },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/dns-query') {
        const name = url.searchParams.get('name') ?? '';
        asked.push(name);
        await held.get(name)?.promise;
        const records = dns[name];
        return Response.json({
          Status: records ? 0 : 3,
          Answer: (records ?? []).map((text) => ({ name, type: 16, data: JSON.stringify(text) })),
        });
      }
      asked.push(url.pathname);
      const body = LOGOS[url.pathname];
      return body
        ? new Response(body, { headers: { 'content-type': 'image/svg+xml' } })
        : new Response('', { status: 404 });
    },
  });
  const here = `https://127.0.0.1:${internet.port}`;
  const enforcing = (domain: string, logo: string, policy = 'reject') => ({
    [`_dmarc.${domain}`]: [`v=DMARC1; p=${policy}; rua=mailto:dmarc@${domain}`],
    [`default._bimi.${domain}`]: [`v=BIMI1; l=${here}${logo}; a=;`],
  });
  dns = {
    ...enforcing('brand.test', '/brand.svg'),
    ...enforcing('forged.test', '/brand.svg'),
    ...enforcing('lax.test', '/brand.svg', 'none'),
    ...enforcing('heavy.test', '/heavy.svg'),
    ...enforcing('scripted.test', '/scripted.svg'),
    ...enforcing('late.test', '/late.svg'),
  };
  worker = await mailrooms({
    AUTH_SERVERS_STAND_IN: JSON.stringify({ localhost: [SIGNER] }),
    DNS_STAND_IN: `${here}/dns-query`,
  });
  await deliver(
    signed('brand', 'news@brand.test', 'pass'),
    // The server found DMARC failed, and the sender wrote a header of their own beneath that says
    // it passed, in the server's name.
    signed('forged', 'deals@forged.test', 'fail', [
      `Authentication-Results: ${SIGNER}; dmarc=pass (p=reject) header.from=forged.test`,
    ]),
    signed('lax', 'hello@lax.test', 'pass'),
    signed('heavy', 'big@heavy.test', 'pass'),
    signed('scripted', 'run@scripted.test', 'pass'),
  );
}, 120_000);

afterAll(async () => {
  worker?.stop();
  await internet?.stop(true);
  await stop();
});

/** The logos the stand-in serves: a brand's, one over 32 KB, and one that would run. */
const LOGOS: Record<string, string> = {
  '/brand.svg': LOGO('#1d2b53'),
  '/late.svg': LOGO('#7a5230'),
  '/heavy.svg': LOGO('#000').replace('</svg>', `<desc>${'x'.repeat(LOGO_BYTES)}</desc></svg>`),
  '/scripted.svg': LOGO('#000').replace('</svg>', '<script>alert(1)</script></svg>'),
};

describe('Verified senders’ logos', () => {
  const ada = member('ada', () => worker);
  const rowFrom = (rows: ConversationSummary[], domain: string) =>
    rows.find((row) => row.senders.some(({ email }) => email.endsWith(`@${domain}`)));

  test('a verified sender whose domain enforces DMARC shows its logo, in lists and conversations', async () => {
    await ada.call('addAccount', setup('localhost'));
    await ada.until(
      async () => rowFrom(await ada.page({ in: 'inbox' }), 'brand.test')?.logo !== undefined,
    );

    const row = rowFrom(await ada.page({ in: 'inbox' }), 'brand.test')!;
    expect(row.logo).toBe('brand.test');
    const [message] = await ada.call<Message[]>('conversation', row.id);
    expect(message).toMatchObject({ verified: true, logo: 'brand.test' });
    expect(await ada.call('logo', 'brand.test')).toBe(LOGOS['/brand.svg']!);
  }, 60_000);

  test('no logo shows for a header forged below the server’s, a domain whose policy is none, or an oversized or scripted logo', async () => {
    await ada.until(async () => {
      const logos = await storedLogos('ada');
      return ['lax.test', 'heavy.test', 'scripted.test'].every(
        (domain) => logos.find((row) => row.domain === domain)?.checked_at,
      );
    });
    const logos = await storedLogos('ada');
    // Mail whose verification was forged is never looked up at all.
    expect(logos.map(({ domain }) => domain).sort()).toEqual([
      'brand.test',
      'heavy.test',
      'lax.test',
      'scripted.test',
    ]);
    for (const domain of ['lax.test', 'heavy.test', 'scripted.test']) {
      expect(logos.find((row) => row.domain === domain)?.svg).toBeNull();
    }
    expect(asked).toContain('/heavy.svg');
    expect(asked).toContain('/scripted.svg');
    expect(asked).not.toContain('_dmarc.forged.test');

    const rows = await ada.page({ in: 'inbox' });
    for (const domain of ['forged.test', 'lax.test', 'heavy.test', 'scripted.test']) {
      const row = rowFrom(rows, domain)!;
      expect(row).not.toHaveProperty('logo');
      const [message] = await ada.call<Message[]>('conversation', row.id);
      expect(message).not.toHaveProperty('logo');
      expect(message?.verified).toBe(domain !== 'forged.test');
      expect(await ada.call('logo', domain)).toBeNull();
    }
  }, 60_000);

  test('a logo found after its mail arrived reaches every open device', async () => {
    const answer = Promise.withResolvers<void>();
    held.set('_dmarc.late.test', answer);
    await deliver(signed('late', 'news@late.test', 'pass'));
    // A device opening has the Mailroom check for mail at once.
    const device = ada.device();
    await device.opened;

    // The mail is listed, without its logo, while DNS is still to answer.
    await ada.until(
      async () => rowFrom(await ada.page({ in: 'inbox' }), 'late.test') !== undefined,
    );
    await ada.until(() => Promise.resolve(asked.includes('_dmarc.late.test')));
    expect(rowFrom(await ada.page({ in: 'inbox' }), 'late.test')).not.toHaveProperty('logo');

    const hinted = device.next((hint) => hint.changed === 'logos');
    answer.resolve();
    await hinted;
    expect(rowFrom(await ada.page({ in: 'inbox' }), 'late.test')?.logo).toBe('late.test');
    device.close();
  }, 60_000);

  test('a server no preset names shows initials, however its mail is signed', async () => {
    const gus = member('gus', () => worker);
    // The stand-in names the server at localhost alone, so at 127.0.0.1 it names none.
    await gus.call('addAccount', setup('127.0.0.1'));
    await gus.until(
      async () => rowFrom(await gus.page({ in: 'inbox' }), 'brand.test') !== undefined,
    );

    const row = rowFrom(await gus.page({ in: 'inbox' }), 'brand.test')!;
    expect(row).not.toHaveProperty('logo');
    const [message] = await gus.call<Message[]>('conversation', row.id);
    expect(message).toMatchObject({ verified: false });
    expect(await storedLogos('gus')).toEqual([]);
  }, 60_000);

  test('a logo goes with the account whose mail named it, and an erase leaves none', async () => {
    const [account] = await ada.call<{ id: string }[]>('accounts');
    await ada.call('removeAccount', account!.id);
    expect(await storedLogos('ada')).toEqual([]);
    expect(await ada.call('logo', 'brand.test')).toBeNull();

    const hal = member('hal', () => worker);
    await hal.call('addAccount', setup('localhost'));
    await hal.until(
      async () => rowFrom(await hal.page({ in: 'inbox' }), 'brand.test')?.logo !== undefined,
    );
    await hal.call('eraseEverything');
    expect(await storedLogos('hal')).toEqual([]);
    expect(await hal.call('logo', 'brand.test')).toBeNull();
  }, 60_000);
});

describe('The demo mailbox’s logos', () => {
  let demo: LocalWorker;
  beforeAll(async () => {
    demo = await mailrooms({
      DEMO_MAILBOX: '300',
      DEMO_MAILBOX_AT: '2026-11-09T12:00:00.000Z',
      DNS_STAND_IN: `https://127.0.0.1:${internet.port}/dns-query`,
    });
  }, 120_000);
  afterAll(() => demo?.stop());

  test('come with it, and nothing is looked up', async () => {
    const dee = member('dee', () => demo);
    asked.length = 0;
    await dee.until(async () =>
      (await dee.page({ in: 'inbox' })).some((row) => row.logo === 'kernelweekly.example.com'),
    );
    expect(await dee.call('logo', 'kernelweekly.example.com')).toBe(
      DEMO_LOGOS['kernelweekly.example.com']!,
    );
    expect(asked).toEqual([]);
  }, 60_000);
});

type LogoRow = { domain: string; svg: string | null; checked_at: number | null };

async function storedLogos(name: string): Promise<LogoRow[]> {
  const { tables } = await member(name, () => worker).call<{ tables: Record<string, unknown[]> }>(
    'stored',
  );
  return (tables.logos ?? []) as LogoRow[];
}

/** A message to Bob, with the Authentication-Results his server wrote on top, and any below it. */
function signed(id: string, from: string, dmarc: 'pass' | 'fail', below: string[] = []) {
  const domain = from.split('@')[1]!;
  return [
    `Authentication-Results: ${SIGNER};`,
    `\tdkim=${dmarc} header.d=${domain};`,
    `\tdmarc=${dmarc} (p=reject dis=none) header.from=${domain}`,
    ...below,
    `From: ${from}`,
    `To: ${bob.email}`,
    `Subject: ${id}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `This is ${id}.`,
    '',
  ].join('\r\n');
}

async function deliver(...messages: string[]) {
  const client = new ImapFlow({
    host: 'localhost',
    port: ports.imaps,
    secure: true,
    auth: { user: bob.email, pass: bob.password },
    tls: { ca: [ca] },
    logger: false,
  });
  await client.connect();
  for (const message of messages) await client.append('INBOX', message);
  await client.logout();
}
