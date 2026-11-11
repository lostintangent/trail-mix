// Verified senders' avatars in the Mailroom on the local Workers runtime, against the test mail
// server, with stand-ins on this machine for the server's signing name, DNS over HTTPS, Gravatar
// and senders' sites: which mail counts as verified, which picture each sender shows and in what
// order, what the Avatar cache keeps, how one found late reaches open devices, and how they go.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ImapFlow } from 'imapflow';
import type { ConversationSummary, Message } from '../../mail/core/index.ts';
import type { AccountSetup } from '../client/contract.ts';
import { DEMO_PICTURES } from '../../providers/index.ts';
import { LOGO_BYTES, PICTURE_BYTES } from '../core/avatars.ts';
import { caFile, empty, ports, start, stop, users } from '../../../../tests/mail-server/server.ts';
import { mailrooms, member } from '../../../../tests/mailrooms.ts';
import type { LocalWorker } from '../../../../tests/workerd.ts';

const { bob } = users;
/** The name the test mail server signs its Authentication-Results with, as a preset would give. */
const SIGNER = 'mx.trailmix.test';
const LOGO = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 8 8"><title>Logo</title><rect width="8" height="8" fill="${color}"/></svg>`;
/** A PNG as its first bytes show one, distinct for each name. */
const PNG = (name: string, size = 0) => {
  const bytes = new Uint8Array(Math.max(size, 8 + name.length));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(name)]);
  return bytes;
};

const setup = (host: string): AccountSetup => ({
  provider: 'imap',
  name: 'Bob',
  address: bob.email,
  imap: { host, port: ports.imaps, secure: true },
  smtp: { host, port: ports.submissions, secure: true },
  password: bob.password,
});

/** DNS, Gravatar and senders' sites, as the stand-in serves them, and every name and path asked of it. */
let internet: ReturnType<typeof Bun.serve>;
const asked: string[] = [];
let dns: Record<string, string[]> = {};
/** Held while a test keeps DNS from answering for a name, until it lets the answer go. */
const held = new Map<string, PromiseWithResolvers<void>>();

let ca: string;
let worker: LocalWorker;

/** The photos Gravatar keeps, by address. */
const PHOTOS: Record<string, Uint8Array> = {
  'news@brand.test': PNG('brand photo'),
  'pat@people.test': PNG('pat'),
};

/** What each path of the stand-in serves, beyond DNS and Gravatar. */
const PATHS: Record<string, () => Response> = {
  '/brand.svg': () => svg(LOGO('#1d2b53')),
  '/late.svg': () => svg(LOGO('#7a5230')),
  '/heavy.svg': () =>
    svg(LOGO('#000').replace('</svg>', `<desc>${'x'.repeat(LOGO_BYTES)}</desc></svg>`)),
  '/scripted.svg': () => svg(LOGO('#000').replace('</svg>', '<script>alert(1)</script></svg>')),
  '/sites/people.test/': () => page('<link rel="icon" href="icon.png">'),
  '/sites/people.test/icon.png': () => image(PNG('people icon')),
  '/sites/iconic.test/': () =>
    page(
      '<link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="icon" href="icon-96.png" sizes="96x96">',
    ),
  '/sites/iconic.test/icon-96.png': () => image(PNG('iconic icon')),
  '/sites/gmail.com/': () => page('<link rel="icon" href="icon.png">'),
  '/sites/gmail.com/icon.png': () => image(PNG('mailbox icon')),
  '/sites/bulky.test/': () =>
    page('<link rel="icon" href="huge.png"><link rel="icon" href="page.png">'),
  '/sites/bulky.test/huge.png': () => image(PNG('huge', PICTURE_BYTES + 1)),
  '/sites/bulky.test/page.png': () => image(new TextEncoder().encode('<!doctype html><p>Hi</p>')),
  '/sites/guarded.test/': () =>
    new Response('<link rel="icon" href="icon.png">', {
      status: 403,
      headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
    }),
};
const svg = (body: string) => new Response(body, { headers: { 'content-type': 'image/svg+xml' } });
const image = (bytes: Uint8Array) =>
  new Response(bytes, { headers: { 'content-type': 'image/png' } });
const page = (head: string) =>
  new Response(`<!doctype html><html><head>${head}</head><body>Hello</body></html>`, {
    headers: { 'content-type': 'text/html' },
  });

const sha256Of = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

beforeAll(async () => {
  await start('full');
  ca = readFileSync(caFile, 'utf8');
  await empty(bob.email);
  const tls = dirname(caFile);
  const gravatar = new Map(
    Object.entries(PHOTOS).map(([address, photo]) => [sha256Of(address), photo]),
  );
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
      if (url.pathname.startsWith('/gravatar/')) {
        const photo = gravatar.get(url.pathname.slice('/gravatar/'.length));
        return photo ? image(photo) : new Response('', { status: 404 });
      }
      return PATHS[url.pathname]?.() ?? new Response('', { status: 404 });
    },
  });
  const here = `https://127.0.0.1:${internet.port}`;
  const dmarc = (domain: string, policy = 'reject') => ({
    [`_dmarc.${domain}`]: [`v=DMARC1; p=${policy}; rua=mailto:dmarc@${domain}`],
  });
  const enforcing = (domain: string, logo: string, policy = 'reject') => ({
    ...dmarc(domain, policy),
    [`default._bimi.${domain}`]: [`v=BIMI1; l=${here}${logo}; a=;`],
  });
  dns = {
    ...enforcing('brand.test', '/brand.svg'),
    ...enforcing('forged.test', '/brand.svg'),
    ...enforcing('lax.test', '/brand.svg', 'none'),
    ...enforcing('heavy.test', '/heavy.svg'),
    ...enforcing('scripted.test', '/scripted.svg'),
    ...enforcing('late.test', '/late.svg'),
    ...dmarc('people.test', 'none'),
    ...dmarc('iconic.test', 'quarantine'),
    ...dmarc('gmail.com', 'none'),
    ...dmarc('bulky.test', 'none'),
    ...dmarc('guarded.test', 'none'),
  };
  worker = await mailrooms({
    AUTH_SERVERS_STAND_IN: JSON.stringify({ localhost: [SIGNER] }),
    AVATARS_STAND_IN: here,
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
    signed('people', 'Pat@People.test', 'pass'),
    signed('iconic', 'hello@iconic.test', 'pass'),
    signed('mailbox', 'friend@gmail.com', 'pass'),
    signed('bulky', 'big@bulky.test', 'pass'),
    signed('guarded', 'hello@guarded.test', 'pass'),
  );
}, 120_000);

afterAll(async () => {
  worker?.stop();
  await internet?.stop(true);
  await stop();
});

const rowFrom = (rows: ConversationSummary[], domain: string) =>
  rows.find((row) => row.senders.some(({ email }) => email.toLowerCase().endsWith(`@${domain}`)));

describe('Verified senders’ avatars', () => {
  const ada = member('ada', () => worker);
  const DOMAINS = [
    'brand.test',
    'lax.test',
    'heavy.test',
    'scripted.test',
    'people.test',
    'iconic.test',
    'gmail.com',
    'bulky.test',
    'guarded.test',
  ];

  test('show a logo, else a photo, else a site’s icon, in lists and conversations', async () => {
    await ada.call('addAccount', setup('localhost'));
    await ada.until(async () => {
      const { domains, senders } = await storedAvatars('ada');
      return (
        [...domains, ...senders].length === 2 * DOMAINS.length &&
        [...domains, ...senders].every((row) => row.checked_at !== null)
      );
    });
    const rows = await ada.page({ in: 'inbox' });
    const shown = async (domain: string) => {
      const row = rowFrom(rows, domain)!;
      const [message] = await ada.call<Message[]>('conversation', row.id);
      expect(message).toMatchObject({ verified: true });
      expect(message?.avatar).toBe(row.avatar);
      return row.avatar && (await pictureOf(ada, row.avatar));
    };

    // Brand's logo, over the photo Gravatar keeps for the same sender.
    expect(await shown('brand.test')).toEqual({
      type: 'image/svg+xml',
      bytes: new TextEncoder().encode(LOGO('#1d2b53')),
    });
    // A person's photo, over their domain's icon, asked for by their address in lowercase.
    expect(await shown('people.test')).toEqual({ type: 'image/png', bytes: PNG('pat') });
    // A site's icon, the smallest it names of at least 64 pixels.
    expect(await shown('iconic.test')).toEqual({ type: 'image/png', bytes: PNG('iconic icon') });
    expect(asked).toContain(`/gravatar/${sha256Of('pat@people.test')}`);
    expect(asked).not.toContain('/sites/iconic.test/favicon-16.png');
  }, 60_000);

  test('show initials for unverified mail, a public mailbox, and pictures that are too big, aren’t pictures, or are kept from the Mailroom', async () => {
    const rows = await ada.page({ in: 'inbox' });
    for (const domain of [
      'forged.test',
      'lax.test',
      'heavy.test',
      'scripted.test',
      'gmail.com',
      'bulky.test',
      'guarded.test',
    ]) {
      const row = rowFrom(rows, domain)!;
      expect(row).not.toHaveProperty('avatar');
      const [message] = await ada.call<Message[]>('conversation', row.id);
      expect(message).not.toHaveProperty('avatar');
      expect(message?.verified).toBe(domain !== 'forged.test');
    }
    const { domains, senders, pictures } = await storedAvatars('ada');
    // Mail whose verification was forged is never looked up at all.
    expect(domains.map(({ domain }) => domain).sort()).toEqual(DOMAINS.toSorted());
    expect(senders).toHaveLength(DOMAINS.length);
    expect(asked).not.toContain('_dmarc.forged.test');
    expect(asked).not.toContain(`/gravatar/${sha256Of('deals@forged.test')}`);
    // A public mailbox's site is never asked, nor the logo of a domain whose policy is none.
    expect(asked).toContain(`/gravatar/${sha256Of('friend@gmail.com')}`);
    expect(asked.filter((path) => path.startsWith('/sites/gmail.com/'))).toEqual([]);
    expect(asked).not.toContain('default._bimi.lax.test');
    for (const path of [
      '/heavy.svg',
      '/scripted.svg',
      '/sites/bulky.test/huge.png',
      '/sites/bulky.test/page.png',
      '/sites/guarded.test/',
    ]) {
      expect(asked).toContain(path);
    }
    // The cache keeps the pictures it shows, and only those.
    // Brand's logo and the photo it outranks, Pat's photo and their domain's icon, and an icon.
    expect(pictures).toHaveLength(5);
  }, 60_000);

  test('a picture found after its mail arrived reaches every open device', async () => {
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
    expect(rowFrom(await ada.page({ in: 'inbox' }), 'late.test')).not.toHaveProperty('avatar');

    const hinted = device.next((hint) => hint.changed === 'avatars');
    answer.resolve();
    await hinted;
    const key = rowFrom(await ada.page({ in: 'inbox' }), 'late.test')?.avatar;
    expect(await pictureOf(ada, key!)).toEqual({
      type: 'image/svg+xml',
      bytes: new TextEncoder().encode(LOGO('#7a5230')),
    });
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
    expect(row).not.toHaveProperty('avatar');
    const [message] = await gus.call<Message[]>('conversation', row.id);
    expect(message).toMatchObject({ verified: false });
    expect(await storedAvatars('gus')).toEqual({ domains: [], senders: [], pictures: [] });
  }, 60_000);

  test('pictures go with the account whose mail named them, and an erase leaves none', async () => {
    const key = rowFrom(await ada.page({ in: 'inbox' }), 'brand.test')!.avatar!;
    const [account] = await ada.call<{ id: string }[]>('accounts');
    await ada.call('removeAccount', account!.id);
    expect(await storedAvatars('ada')).toEqual({ domains: [], senders: [], pictures: [] });
    expect(await pictureOf(ada, key)).toBeNull();

    const hal = member('hal', () => worker);
    await hal.call('addAccount', setup('localhost'));
    await hal.until(
      async () => rowFrom(await hal.page({ in: 'inbox' }), 'brand.test')?.avatar !== undefined,
    );
    await hal.call('eraseEverything');
    expect(await storedAvatars('hal')).toEqual({ domains: [], senders: [], pictures: [] });
    expect(await pictureOf(hal, key)).toBeNull();
  }, 60_000);
});

describe('The demo mailbox’s pictures', () => {
  let demo: LocalWorker;
  beforeAll(async () => {
    demo = await mailrooms({
      DEMO_MAILBOX: '300',
      DEMO_MAILBOX_AT: '2026-11-09T12:00:00.000Z',
      AVATARS_STAND_IN: `https://127.0.0.1:${internet.port}`,
    });
  }, 120_000);
  afterAll(() => demo?.stop());

  test('come with it, a logo, a photo and a site’s icon, and nothing is looked up', async () => {
    const dee = member('dee', () => demo);
    asked.length = 0;
    const from = async (address: string) => {
      const row = (await dee.page({ in: 'inbox' })).find((row) =>
        row.senders.some(({ email }) => email === address),
      );
      if (!row) return undefined;
      const messages = await dee.call<Message[]>('conversation', row.id);
      return messages.find((message) => message.from.email === address)?.avatar;
    };
    const shows = async (address: string, picture: string) => {
      await dee.until(async () => (await from(address)) !== undefined);
      expect(await pictureOf(dee, (await from(address))!)).toEqual({
        type: 'image/svg+xml',
        bytes: new TextEncoder().encode(picture),
      });
    };
    await shows('hello@kernelweekly.example.com', DEMO_PICTURES.logos['kernelweekly.example.com']!);
    await shows('ada@example.com', DEMO_PICTURES.photos['ada@example.com']!);
    await shows('billing@fieldnote.example.com', DEMO_PICTURES.icons['fieldnote.example.com']!);
    expect(asked).toEqual([]);
  }, 60_000);
});

/** The picture a member's Avatar cache serves under a key, or null. */
async function pictureOf(
  who: ReturnType<typeof member>,
  key: string,
): Promise<{ type: string; bytes: Uint8Array } | null> {
  const picture = await who.call<{ type: string; bytes: Record<string, number> } | null>(
    'avatar',
    key,
  );
  return picture && { type: picture.type, bytes: new Uint8Array(Object.values(picture.bytes)) };
}

type Looked = { checked_at: number | null };

async function storedAvatars(name: string) {
  const { tables } = await member(name, () => worker).call<{ tables: Record<string, unknown[]> }>(
    'stored',
  );
  return {
    domains: (tables.avatar_domains ?? []) as (Looked & { domain: string })[],
    senders: (tables.avatar_senders ?? []) as (Looked & { sender: string })[],
    pictures: (tables.avatar_pictures ?? []) as { key: string }[],
  };
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
