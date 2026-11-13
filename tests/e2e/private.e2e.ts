// Two members signed in through Cloudflare Access to one deployment, each reaching only their own
// Mailroom: the built app on workerd, with Access's certificates served over TLS from this machine
// and each member's sign-in a token signed with its key. The second asks for what the first holds,
// by the first's own refs, through the queries and the routes that serve a message's bytes. The
// Mailroom's own tests cover its commands and hint socket, and `entry.test.ts` the Worker's gate.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { fromCrossJSON, toJSON, type SerovalNode } from 'seroval';
import {
  isBundle,
  type ConversationSummary,
  type Message,
  type MessageRef,
} from '../../src/features/mail/core/index.ts';
import type { Page } from '../../src/features/mailroom/client/contract.ts';
import { messageUrl, partUrl } from '../../src/features/mailroom/client/urls.ts';
import { serverFunctionIds, startPreview, type Preview } from './preview.ts';

const AUD = 'trail-mix-private';
const ADA = 'ada@example.com';
const BEA = 'bea@example.com';

let preview: Preview;
let certificates: ReturnType<typeof Bun.serve>;
let team: string;
let sign: (email: string) => Promise<string>;
const tls = mkdtempSync(join(tmpdir(), 'trail-mix-access-'));

beforeAll(async () => {
  // A certificate authority this machine's Worker trusts, and Access's certificates behind it.
  await $`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Trail-Mix-test-CA -keyout ca.key -out ca.crt`
    .cwd(tls)
    .quiet();
  writeFileSync(
    join(tls, 'server.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n',
  );
  await $`openssl req -new -newkey rsa:2048 -nodes -subj /CN=localhost -keyout server.key -out server.csr`
    .cwd(tls)
    .quiet();
  await $`openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile server.ext -out server.crt`
    .cwd(tls)
    .quiet();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = { ...(await exportJWK(publicKey)), kid: 'access', alg: 'RS256', use: 'sig' };
  certificates = Bun.serve({
    hostname: 'localhost',
    port: 0,
    tls: { cert: Bun.file(join(tls, 'server.crt')), key: Bun.file(join(tls, 'server.key')) },
    fetch: () => Response.json({ keys: [key] }),
  });
  team = `localhost:${certificates.port}`;
  sign = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'access' })
      .setIssuer(`https://${team}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  preview = await startPreview(
    { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD, DEMO_MAILBOX: '200', DEV_MEMBER: '' },
    { NODE_EXTRA_CA_CERTS: join(tls, 'ca.crt') },
  );
}, 120_000);

afterAll(async () => {
  await preview?.stop();
  await certificates?.stop(true);
  rmSync(tls, { recursive: true, force: true });
});

/** What a member's browser sends with every request: their sign-in, from Trail Mix's own page. */
const as = async (email: string) => ({
  'Cf-Access-Jwt-Assertion': await sign(email),
  'Sec-Fetch-Site': 'same-origin',
});

/** A query, as the browser's `rpc.ts` asks it, and its answer or the status that refused it. */
async function ask<T>(email: string, name: string, ...args: unknown[]): Promise<T> {
  const url = new URL(`/_serverFn/${serverFunctionIds().query}`, preview.url);
  url.searchParams.set('payload', JSON.stringify(toJSON({ data: { name, args } })));
  const response = await fetch(url, {
    headers: { ...(await as(email)), 'x-tsr-serverFn': 'true' },
  });
  // A refusal says what the Worker answered, so one that happens once can be told apart.
  if (!response.ok) {
    const said = (await response.text()).slice(0, 500);
    throw new Error(`${name} was refused with ${response.status}: ${said}`);
  }
  // Start sends the handler's result under `result`, or what it threw under `error`, in a form of
  // its own, whose message is plain.
  const text = await response.text();
  const refusal = /^\{"t":10,"i":0,"p":\{"k":\["error"\].*?"message":\{"t":1,"s":"([^"]*)"/.exec(
    text,
  );
  if (refusal) throw new Error(`${name} was refused: ${refusal[1]}`);
  const node = JSON.parse(text) as SerovalNode;
  const answer: { result: T } = fromCrossJSON(node, { refs: new Map() });
  return answer.result;
}

/** The status of a request for a message's bytes, as an image or a download asks for them. */
const bytes = async (email: string, path: string) =>
  (await fetch(new URL(path, preview.url), { headers: await as(email) })).status;

/** Waits until a check holds, or fails once `ms` have passed without it. */
async function until(check: () => Promise<boolean> | boolean, ms: number) {
  const by = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > by) throw new Error(`Still not so after ${ms} ms.`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe('Two members of one deployment', () => {
  test('the second reaches none of the first’s mail by its refs: not its list, body, source or parts', async () => {
    let rows: ConversationSummary[] = [];
    await until(async () => {
      rows = (await ask<Page>(ADA, 'conversations', { in: 'inbox' })).items.filter(
        (item): item is ConversationSummary => !isBundle(item),
      );
      return rows.some(({ hasAttachments }) => hasAttachments);
    }, 60_000);
    const row = rows.find(({ hasAttachments }) => hasAttachments)!;
    const message = (await ask<Message[]>(ADA, 'conversation', row.id)).find(
      ({ hasAttachments }) => hasAttachments,
    )!;
    const ref: MessageRef = {
      account: message.account,
      path: message.path,
      uidValidity: message.uidValidity,
      uid: message.uid,
    };
    const body = await ask<{ attachments: { id: string }[] }>(ADA, 'body', ref);
    const attachment = body.attachments[0]!.id;
    // The first member reaches all of it.
    expect([await bytes(ADA, messageUrl(ref)), await bytes(ADA, partUrl(ref, attachment))]).toEqual(
      [200, 200],
    );

    // The second, asking by the same refs, reaches none of it, through any route.
    expect(await ask(BEA, 'conversation', row.id)).toEqual([]);
    await expect(ask(BEA, 'body', ref)).rejects.toThrow(
      'body was refused: That message is no longer in this mailbox.',
    );
    expect([await bytes(BEA, messageUrl(ref)), await bytes(BEA, partUrl(ref, attachment))]).toEqual(
      [404, 404],
    );
    // A request no one signed in to reaches no Mailroom at all.
    const unsigned = await fetch(new URL(messageUrl(ref), preview.url));
    expect(unsigned.status).toBe(401);
  }, 90_000);
});
