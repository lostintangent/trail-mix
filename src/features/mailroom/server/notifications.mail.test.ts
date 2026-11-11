// The Mailroom notifying a member's devices of new Inbox mail, on the local Workers runtime against
// the test mail server, with each push opened by a stand-in push service as the device would.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { addressOf, type Account, type MessageRef } from '../../mail/core/index.ts';
import { pushOf, type Notice } from '../../notifications/index.ts';
import { standInPushService } from '../../../../tests/push-service.ts';
import type { AccountSetup, ThisDevice } from '../client/contract.ts';
import { caFile, empty, ports, start, stop, users } from '../../../../tests/mail-server/server.ts';
import { mailrooms, member } from '../../../../tests/mailrooms.ts';
import type { LocalWorker } from '../../../../tests/workerd.ts';
import type { Pushed } from './test-worker.ts';

const { alice, bob } = users;
const OPERATOR = 'operator@trailmix.test';
const setup: AccountSetup = {
  provider: 'imap',
  name: 'Bob',
  address: bob.email,
  imap: { host: 'localhost', port: ports.imaps, secure: true },
  smtp: { host: 'localhost', port: ports.submissions, secure: true },
  password: bob.password,
};

let ca: string;

describe('The Mailroom, notifying devices', () => {
  let worker: LocalWorker;
  let account: Account;
  const nia = member('nia', () => worker);
  let service: Awaited<ReturnType<typeof standInPushService>>;
  /** How many of the Mailroom's pushes the stand-in has opened. */
  let opened = 0;

  beforeAll(async () => {
    await start('full');
    ca = readFileSync(caFile, 'utf8');
    await empty(bob.email);
    await arrive({ id: 'waiting', subject: 'Already waiting' });
    worker = await mailrooms({ PUSH_KEY: pushKeyPem(), OPERATOR_EMAIL: OPERATOR });
    service = await standInPushService();
  }, 120_000);

  afterAll(async () => {
    worker?.stop();
    await stop();
  });

  /**
   * Has the Mailroom check now, as opening a device does, until `count` more pushes have gone and
   * no more follow, and returns them as the device opened them.
   */
  async function pushed(count: number) {
    const device = nia.device();
    await device.opened;
    const sent = async () => (await nia.call<Pushed[]>('pushes')).length;
    await nia.until(async () => (await sent()) >= opened + count);
    // Any push the same news would wrongly add goes in the same wake, right after.
    await Bun.sleep(1_000);
    device.close();
    const pushes = (await nia.call<Pushed[]>('pushes')).slice(opened);
    opened += pushes.length;
    const from = service.received.length;
    for (const { url, headers, body } of pushes) {
      const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      await service.post(new Request(url, { method: 'POST', headers, body: bytes }));
    }
    return service.received.slice(from);
  }

  const thisDevice = () => nia.call<ThisDevice>('thisDevice', service.subscription.endpoint);
  const subjectsOf = (pushes: { message: unknown }[]) =>
    pushes.map(
      ({ message }) =>
        (message as { notification: { body: string } }).notification.body.split('\n')[0],
    );

  test('tells a device turned on of new Inbox mail, sealed for it and signed by the deployment, and nothing of an account’s first sync', async () => {
    const before = await thisDevice();
    expect(before).toMatchObject({ notified: false });
    expect(before.pushKey).toMatch(/^[\w-]{87}$/);
    await nia.call('notifyDevice', { ...service.subscription, expirationTime: null });
    expect(await thisDevice()).toEqual({ ...before, notified: true });
    // Bob's mail already waiting is read for the first time, and isn't news.
    account = await nia.call<Account>('addAccount', setup);
    await nia.until(async () => (await nia.call<Account[]>('accounts'))[0]?.status === 'ready');

    await arrive({ id: 'ridge', subject: 'Ridge trip' });
    const [push, ...more] = await pushed(1);
    expect(more).toEqual([]);
    const message = await inInbox('Ridge trip');
    const notice: Notice = {
      title: 'Alice',
      body: 'Ridge trip\nThis is Ridge trip.',
      tag: message.conversation,
      navigate: addressOf({ view: { in: 'inbox' }, open: message.conversation }),
      message: refOf(message),
    };
    expect(push?.message).toEqual(pushOf(notice));
    expect(push?.key).toBe(before.pushKey);
    expect(push?.claims).toMatchObject({ aud: 'https://push.example', sub: `mailto:${OPERATOR}` });
    expect([push?.ttl, push?.urgency]).toEqual(['86400', 'normal']);
  });

  test('stays quiet about mail already read, mail dated days ago, and mail the member moved back in', async () => {
    await arrive({ id: 'read', subject: 'Read elsewhere', seen: true });
    await arrive({ id: 'late', subject: 'Late letter', minutesAgo: 3 * 24 * 60 });
    // Archived, and moved back as Undo does, it comes back under a new UID.
    const ridge = await inInbox('Ridge trip');
    const [archived] = await nia.call<{ to: MessageRef }[]>('move', [refOf(ridge)], 'archive');
    await nia.call('move', [archived!.to], { account: account.id, path: 'INBOX' });
    // Archive has been read since, so only its role keeps this quiet.
    await arrive({ id: 'filed', subject: 'Filed by a rule', folder: 'Archive' });
    await arrive({ id: 'control', subject: 'Control' });
    expect(subjectsOf(await pushed(1))).toEqual(['Control']);
  });

  test('tells more conversations than it tells one by one as one summary', async () => {
    for (const id of ['one', 'two', 'three', 'four']) await arrive({ id, subject: `Letter ${id}` });
    const pushes = await pushed(1);
    expect(pushes.map(({ message }) => message)).toEqual([
      pushOf({ title: '4 new messages', body: 'In Bob', tag: 'news', navigate: '/' }),
    ]);
  });

  test('keeps a device whose push service refused the deployment’s key, and forgets one whose subscription ended', async () => {
    await nia.call('answerPushesWith', 403);
    await arrive({ id: 'refused', subject: 'Refused' });
    expect(subjectsOf(await pushed(1))).toEqual(['Refused']);
    expect(await thisDevice()).toMatchObject({ notified: true });

    await nia.call('answerPushesWith', 410);
    await arrive({ id: 'ended', subject: 'Ended' });
    expect(subjectsOf(await pushed(1))).toEqual(['Ended']);
    expect(await thisDevice()).toMatchObject({ notified: false });
    await nia.call('answerPushesWith', 201);
  });

  test('checks mail every four minutes while a device is notified, and every five otherwise', async () => {
    const minutesToNextCheck = async () => {
      await nia.call('wakeNow');
      const { alarm } = await nia.call<{ alarm: number }>('wakeNow');
      return Math.round((alarm - Date.now()) / 60_000);
    };
    expect(await minutesToNextCheck()).toBe(5);
    await nia.call('notifyDevice', service.subscription);
    expect(await minutesToNextCheck()).toBe(4);
    await nia.call('forgetDevice', service.subscription.endpoint);
    expect(await minutesToNextCheck()).toBe(5);
    expect(await thisDevice()).toMatchObject({ notified: false });
  });

  test('refuses a device it can’t reach, and an endpoint that isn’t one', async () => {
    await expect(
      nia.call('notifyDevice', { ...service.subscription, endpoint: 'http://push.example/1' }),
    ).rejects.toThrow('A push service is reached over HTTPS.');
    await expect(nia.call('thisDevice', 42)).rejects.toThrow(
      'A device is named by its push endpoint.',
    );
    await expect(nia.call('forgetDevice', ['x'])).rejects.toThrow(
      'A device is named by its push endpoint.',
    );
  });

  test('forgets an account’s marks with it, and every device with an erase', async () => {
    await nia.call('notifyDevice', service.subscription);
    const stored = async () =>
      (await nia.call<{ tables: Record<string, unknown[]> }>('stored')).tables;
    expect((await stored()).devices).toHaveLength(1);
    expect((await stored()).news_marks).toEqual([
      { account: account.id, path: 'INBOX', mark: expect.any(String) as string },
    ]);
    await nia.call('removeAccount', account.id);
    expect((await stored()).news_marks).toEqual([]);
    await nia.call('eraseEverything');
    expect((await stored()).devices).toEqual([]);
  });

  /** The Inbox message with this subject, as the index holds it. */
  async function inInbox(subject: string) {
    const [row] = (await nia.page({ in: 'inbox' })).filter((each) => each.subject === subject);
    if (!row) throw new Error(`No “${subject}” in the Inbox.`);
    const messages = await nia.call<
      (MessageRef & { path: string; subject: string; conversation: string })[]
    >('conversation', row.id);
    const message = messages.find((each) => each.path === 'INBOX' && each.subject === subject);
    if (!message) throw new Error(`No “${subject}” message in the Inbox.`);
    return message;
  }
});

describe('A Trail Mix without a push key', () => {
  let worker: LocalWorker;
  const ola = member('ola', () => worker);

  beforeAll(async () => {
    worker = await mailrooms({ OPERATOR_EMAIL: OPERATOR });
  }, 60_000);

  afterAll(() => worker?.stop());

  test('gives no key to subscribe with, and turns no device on', async () => {
    const service = await standInPushService();
    expect(await ola.call<ThisDevice>('thisDevice', service.subscription.endpoint)).toEqual({
      cache: expect.any(String) as string,
      notified: false,
    });
    await expect(ola.call('notifyDevice', service.subscription)).rejects.toThrow(
      'Notifications aren’t set up on this Trail Mix.',
    );
  });
});

/**
 * Mail from Alice landing in Bob's Inbox, or another folder, as a server's rule files it: unseen
 * unless said, and dated a minute ago unless said.
 */
async function arrive(fields: {
  id: string;
  subject: string;
  seen?: boolean;
  minutesAgo?: number;
  folder?: string;
}) {
  const client = new ImapFlow({
    host: 'localhost',
    port: ports.imaps,
    secure: true,
    auth: { user: bob.email, pass: bob.password },
    tls: { ca: [ca] },
    logger: false,
  });
  await client.connect();
  try {
    const raw = [
      `From: Alice <${alice.email}>`,
      `To: ${bob.email}`,
      `Subject: ${fields.subject}`,
      `Date: ${new Date(Date.now() - (fields.minutesAgo ?? 1) * 60_000).toUTCString()}`,
      `Message-ID: <${fields.id}@trailmix.test>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `This is ${fields.subject}.`,
      '',
    ].join('\r\n');
    await client.append(fields.folder ?? 'INBOX', raw, fields.seen ? ['\\Seen'] : []);
  } finally {
    await client.logout();
  }
}

/** A new P-256 key in PKCS #8 PEM, as the deploy makes `PUSH_KEY`. */
function pushKeyPem() {
  const made = Bun.spawnSync([
    'openssl',
    'genpkey',
    '-algorithm',
    'EC',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
  ]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return made.stdout.toString();
}

const refOf = ({ account, path, uidValidity, uid }: MessageRef): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});
