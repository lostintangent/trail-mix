// The test mail server must behave like the hosts it stands in for, gaps included. These tests
// start it themselves, so they restart a server that is already running.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect as tcp } from 'node:net';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import {
  caFile,
  count,
  emptyFolder,
  fileSentCopies,
  identity,
  ports,
  type Profile,
  settled,
  start,
  stop,
  users,
} from './server.ts';
import { signedIn } from './sign-in.ts';

setDefaultTimeout(30_000);
afterAll(stop);

const { alice, bob } = users;
type Auth = { user: string; pass: string } | { user: string; accessToken: string };

async function session<T>(
  use: (client: ImapFlow) => Promise<T>,
  auth: Auth = { user: bob.email, pass: bob.password },
) {
  const client = new ImapFlow({
    host: 'localhost',
    port: ports.imaps,
    secure: true,
    auth,
    tls: { ca: readFileSync(caFile) },
    logger: false,
  });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.logout();
  }
}
const capabilities = () =>
  session((client) => Promise.resolve(new Set(client.capabilities.keys())));
/**
 * RFC 6154's attributes, which name a folder's role. Dovecot adds others, such as `\UnMarked` on a
 * folder it has seen before, so a laptop that ran the tests earlier lists them where CI doesn't.
 */
const ROLES = new Set([
  '\\All',
  '\\Archive',
  '\\Drafts',
  '\\Flagged',
  '\\Junk',
  '\\Sent',
  '\\Trash',
]);
const foldersWithRoles = () =>
  session(async (client) =>
    (await client.list())
      .filter((f) => [...f.flags].some((flag) => ROLES.has(flag)))
      .map((f) => f.path),
  );
function submit(
  port: number,
  message: { from: string; to: string },
  auth: Record<string, string> = { user: alice.email, pass: alice.password },
) {
  const secure = port === ports.submissions;
  const transport = nodemailer.createTransport({
    host: 'localhost',
    port,
    secure,
    requireTLS: !secure,
    auth,
    tls: { ca: readFileSync(caFile) },
  });
  return transport.sendMail({ ...message, subject: 'server test', text: 'server test' });
}

/** What each profile advertises and withholds, as its host does, and the folders it marks with roles. */
const PROFILES: Record<Profile, { has: string[]; lacks: string[]; roles?: string[] }> = {
  full: {
    has: ['IDLE', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'QRESYNC', 'SPECIAL-USE'],
    lacks: [],
    roles: ['Archive', 'Drafts', 'Junk', 'Sent', 'Trash'],
  },
  zoho: {
    has: ['IDLE', 'UIDPLUS', 'MOVE', 'CONDSTORE'],
    lacks: ['QRESYNC', 'SPECIAL-USE', 'SORT', 'THREAD=REFERENCES'],
    roles: [],
  },
  outlook: { has: ['IDLE', 'UIDPLUS', 'MOVE', 'SPECIAL-USE'], lacks: ['CONDSTORE', 'QRESYNC'] },
  plain: {
    has: ['IDLE'],
    lacks: ['UIDPLUS', 'MOVE', 'CONDSTORE', 'QRESYNC', 'SPECIAL-USE'],
    roles: [],
  },
};

describe('profiles', () => {
  for (const [profile, { has, lacks, roles }] of Object.entries(PROFILES)) {
    test(`${profile} offers ${has.join(', ')}, and withholds ${lacks.join(', ') || 'nothing'}`, async () => {
      await start(profile as Profile);
      const caps = await capabilities();
      for (const cap of has) expect(caps).toContain(cap);
      for (const cap of lacks) expect(caps).not.toContain(cap);
      if (roles) expect((await foldersWithRoles()).sort()).toEqual(roles);
    });
  }
});

describe('submission', () => {
  test('refuses AUTH before STARTTLS', async () => {
    await start();
    const replies = await converse(ports.submission, [
      'EHLO probe',
      `AUTH PLAIN ${btoa(`\0${alice.email}\0${alice.password}`)}`,
      'QUIT',
    ]);
    expect(replies).toContain('STARTTLS');
    expect(replies).toMatch(/^538 /m);
    expect(replies).not.toMatch(/^235 /m);
  });

  test('refuses recipients outside the test domain', async () => {
    await start();
    await expect(
      submit(ports.submissions, { from: alice.email, to: 'someone@example.com' }),
    ).rejects.toThrow(/550/);
  });

  test('refuses a sender other than the signed-in user', async () => {
    await start();
    await expect(submit(ports.submissions, { from: bob.email, to: bob.email })).rejects.toThrow(
      /553/,
    );
  });
});

describe('the host’s own copy in Sent', () => {
  const sent = () => count(alice.email, 'Sent');
  const send = () => submit(ports.submissions, { from: alice.email, to: alice.email });

  test('a test chooses whether it is filed at once, held until settled, or never', async () => {
    await start('zoho');
    await emptyFolder(alice.email, 'Sent');
    fileSentCopies(alice.email, 'at-once');
    await send();
    expect(await sent()).toBe(1);

    fileSentCopies(alice.email, 'held');
    await send();
    await Bun.sleep(1000);
    expect(await sent()).toBe(1);
    await settled();
    expect(await sent()).toBe(2);

    fileSentCopies(alice.email, 'never');
    await send();
    await settled();
    expect(await sent()).toBe(2);
  });
});

describe('OAuth', () => {
  test('IMAP and submission refuse a token the stand-in never issued, or issued to someone else', async () => {
    await start('outlook');
    const bobs = (await signedIn(identity.origin, bob.email)).access;
    for (const accessToken of ['never-issued', bobs]) {
      await expect(session(async () => {}, { user: alice.email, accessToken })).rejects.toThrow();
      await expect(
        submit(
          ports.submission,
          { from: alice.email, to: alice.email },
          { type: 'OAuth2', user: alice.email, accessToken },
        ),
      ).rejects.toThrow(/535/);
    }
  });

  // Dovecot keeps no cache of what a token was, so a lapsed sign-in shows at the next login.
  test('IMAP and submission refuse a token once it has expired', async () => {
    await start('outlook');
    const accessToken = (await signedIn(identity.origin, alice.email, 1)).access;
    const auth = { user: alice.email, accessToken };
    await session(async () => {}, auth);
    await Bun.sleep(1100);
    await expect(session(async () => {}, auth)).rejects.toThrow();
    await expect(
      submit(ports.submission, { from: alice.email, to: alice.email }, { type: 'OAuth2', ...auth }),
    ).rejects.toThrow(/535/);
  });
});

/** Sends each line once the previous reply is complete, and returns everything the server said. */
function converse(port: number, lines: string[]) {
  return new Promise<string>((resolve, reject) => {
    const socket = tcp(port, '127.0.0.1');
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString();
      const last = text.split('\r\n').at(-2) ?? '';
      if (text.endsWith('\r\n') && /^\d{3} /.test(last)) {
        const next = lines.shift();
        if (next) socket.write(`${next}\r\n`);
      }
    });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
}
