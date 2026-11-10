// The test mail server must behave like the hosts it stands in for, gaps included. These tests
// start it themselves, so they restart a server that is already running.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect as tcp } from 'node:net';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { caFile, identity, ports, resetUidValidity, start, stop, users } from './server.ts';

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
const foldersWithRoles = () =>
  session(async (client) =>
    (await client.list())
      .filter((f) => [...f.flags].some((flag) => !/^\\Has(No)?Children$/.test(flag)))
      .map((f) => f.path),
  );
/** UIDVALIDITY and the message count of bob's Inbox. */
async function inbox() {
  const status = await session((client) =>
    client.status('INBOX', { uidValidity: true, messages: true }),
  );
  if (!status) throw new Error('STATUS INBOX failed');
  return { uidValidity: status.uidValidity, messages: status.messages ?? 0 };
}

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

/** A token from the stand-in for Microsoft's sign-in, as a person signing in would get one. */
async function tokenFor(user: string) {
  const post = (path: string, form: Record<string, string>) =>
    fetch(`${identity.authority}${path}`, { method: 'POST', body: new URLSearchParams(form) });
  const started = await post('/oauth2/v2.0/devicecode', {
    client_id: 'server-test',
    scope: 'imap',
  });
  const code = await started.json<Record<string, string>>();
  await fetch(`http://127.0.0.1:${ports.identity}/devicelogin`, {
    method: 'POST',
    body: new URLSearchParams({ user_code: code.user_code ?? '', login_hint: user }),
  });
  const grant = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: 'server-test',
    device_code: code.device_code ?? '',
  };
  const token = await (await post('/oauth2/v2.0/token', grant)).json<Record<string, string>>();
  return token.access_token ?? '';
}

describe('profiles', () => {
  test('full advertises everything the sync code may use, and marks folder roles', async () => {
    await start('full');
    const caps = await capabilities();
    for (const cap of ['IDLE', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'QRESYNC', 'SPECIAL-USE'])
      expect(caps).toContain(cap);
    expect((await foldersWithRoles()).sort()).toEqual([
      'Archive',
      'Drafts',
      'Junk',
      'Sent',
      'Trash',
    ]);
  });

  test('zoho withholds QRESYNC, SPECIAL-USE, SORT and THREAD, and marks no folder roles', async () => {
    await start('zoho');
    const caps = await capabilities();
    for (const cap of ['IDLE', 'UIDPLUS', 'MOVE', 'CONDSTORE']) expect(caps).toContain(cap);
    for (const cap of ['QRESYNC', 'SPECIAL-USE', 'SORT', 'THREAD=REFERENCES'])
      expect(caps).not.toContain(cap);
    expect(await foldersWithRoles()).toEqual([]);
  });

  test('outlook withholds CONDSTORE and QRESYNC', async () => {
    await start('outlook');
    const caps = await capabilities();
    for (const cap of ['IDLE', 'UIDPLUS', 'MOVE', 'SPECIAL-USE']) expect(caps).toContain(cap);
    for (const cap of ['CONDSTORE', 'QRESYNC']) expect(caps).not.toContain(cap);
  });

  test('plain withholds every extension but IDLE, and marks no folder roles', async () => {
    await start('plain');
    const caps = await capabilities();
    expect(caps).toContain('IDLE');
    for (const cap of ['UIDPLUS', 'MOVE', 'CONDSTORE', 'QRESYNC', 'SPECIAL-USE'])
      expect(caps).not.toContain(cap);
    expect(await foldersWithRoles()).toEqual([]);
  });
});

describe('mailboxes', () => {
  test('reset-uidvalidity gives a folder a new UIDVALIDITY and keeps its messages', async () => {
    await start();
    await submit(ports.submissions, { from: alice.email, to: bob.email });
    const before = await inbox();
    await resetUidValidity(bob.email, 'INBOX');
    const after = await inbox();
    expect(after.uidValidity).not.toBe(before.uidValidity);
    expect(after.messages).toBe(before.messages);
  });
});

describe('submission', () => {
  test('delivers over implicit TLS and over STARTTLS', async () => {
    await start();
    const before = await inbox();
    await submit(ports.submissions, { from: alice.email, to: bob.email });
    await submit(ports.submission, { from: alice.email, to: bob.email });
    expect((await inbox()).messages).toBe(before.messages + 2);
  });

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

describe('OAuth', () => {
  test('IMAP and submission accept a token from the stand-in for Microsoft', async () => {
    await start('outlook');
    const accessToken = await tokenFor(alice.email);
    const folders = await session(async (client) => (await client.list()).length, {
      user: alice.email,
      accessToken,
    });
    expect(folders).toBeGreaterThan(0);
    const sent = await submit(
      ports.submission,
      { from: alice.email, to: alice.email },
      { type: 'OAuth2', user: alice.email, accessToken },
    );
    expect(sent.response).toStartWith('250');
  });

  test('IMAP and submission refuse a token the stand-in never issued, or issued to someone else', async () => {
    await start('outlook');
    const bobs = await tokenFor(bob.email);
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
