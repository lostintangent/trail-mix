// The check Worker. A Durable Object asks one account, on the Workers runtime and through the IMAP
// and SMTP provider the Mailroom uses, what a Mailroom asks: its folders, its newest message, a
// send to itself as the Outbox sends, and news of new mail while it watches the Inbox. The secret
// arrives in the request body and lives only for that request: nothing here stores, logs or returns
// it, and no mail content leaves the object.
import { connect } from 'cloudflare:sockets';
import { createSocketsTransport } from 'imapflow';
import type { Endpoint, MailProvider } from '../../src/features/providers/index.ts';
import { imapProvider } from '../../src/features/providers/imap/provider.ts';

export type CheckRequest = {
  user: string;
  /** A password, or an access token when `oauth`. */
  secret: string;
  oauth: boolean;
  imap: Endpoint;
  smtp: Endpoint;
  filesSent: boolean;
  /** How long to watch the Inbox before sending to self and waiting to be told. Zero skips it. */
  watchSeconds: number;
};

export type CheckResult = {
  check: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
};

type Namespace = {
  newUniqueId(): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

/** How long a send waits for a host that files its own copy in Sent, as the Outbox does. */
const HOST_FILING_MS = 120_000;

export default {
  async fetch(request: Request, env: { CHECK: Namespace }): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/run') {
      return new Response(null, { status: 404 });
    }
    return env.CHECK.get(env.CHECK.newUniqueId()).fetch(request);
  },
};

/**
 * Answers with one JSON line per check as it finishes, so results show while a long watch runs. A
 * blank line every 30 seconds keeps the response from looking idle to the client.
 */
export class Check {
  async fetch(request: Request): Promise<Response> {
    const check = await request.json<CheckRequest>();
    const { user, secret } = check;
    const provider = imapProvider(
      {
        account: 'check',
        imap: check.imap,
        smtp: check.smtp,
        auth: check.oauth
          ? { user, accessToken: () => Promise.resolve(secret) }
          : { user, pass: secret },
        filesSent: check.filesSent,
      },
      {
        // As the Mailroom passes it. Its types want `allowHalfOpen` given.
        imapTransport: createSocketsTransport((address, options) =>
          connect(
            address,
            options && { ...options, allowHalfOpen: options.allowHalfOpen ?? false },
          ),
        ),
      },
    );
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (line: string) => writer.write(encoder.encode(`${line}\n`));

    void (async () => {
      const heartbeat = setInterval(() => void send(''), 30_000);
      try {
        await send(JSON.stringify({ runtime: navigator.userAgent }));
        for (const [name, run] of checks(check, provider)) {
          await send(JSON.stringify(await timed(name, run)));
        }
      } finally {
        clearInterval(heartbeat);
        await provider.close().catch(() => {});
        await writer.close();
      }
    })();
    return new Response(readable, { headers: { 'content-type': 'application/x-ndjson' } });
  }
}

function checks(check: CheckRequest, provider: MailProvider) {
  const { imap, smtp, watchSeconds } = check;
  const tls = smtp.secure ? 'implicit TLS' : 'STARTTLS';
  const steps: [string, () => Promise<unknown>][] = [
    [`list folders and open the newest message over ${imap.port}`, () => listAndOpen(provider)],
    [`send to self over ${smtp.port} (${tls})`, () => sendToSelf(check, provider)],
  ];
  if (watchSeconds > 0) {
    steps.push([
      `watch INBOX for ${watchSeconds}s, then see new mail`,
      () => watch(check, provider),
    ]);
  }
  return steps;
}

async function listAndOpen(provider: MailProvider) {
  const folders = await provider.folders();
  const { events } = await provider.sync('INBOX', null, { since: new Date(0).toISOString() });
  const newest = events.find((event) => event.type === 'message')?.envelope;
  const body = newest && (await new Response(await provider.body(newest)).arrayBuffer());
  return {
    folders: folders.map(({ path, role }) => (role ? `${path} (${role})` : path)),
    newest: newest ? { uid: newest.uid, bytes: body?.byteLength } : null,
  };
}

/**
 * One message from the account to itself, so a check never mails anyone else, sent as the Outbox
 * sends: saved in Drafts, submitted, then filed in Sent, which takes the draft away. A host that
 * files its own copy is waited for as the Outbox waits. A send that stops partway says what it left.
 */
async function sendToSelf({ user, filesSent }: CheckRequest, provider: MailProvider) {
  const messageId = `<${crypto.randomUUID()}@check.trail-mix>`;
  const subject = `Trail Mix check ${new Date().toISOString()}`;
  const message = [
    `From: ${user}`,
    `To: ${user}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    '',
    `${subject}. Sent by Trail Mix's mail check. Delete it at will.`,
  ].join('\r\n');
  let left: string | undefined;
  try {
    const draft = await provider.saveDraft(new TextEncoder().encode(message));
    left = 'its draft in Drafts';
    if ((await provider.submit(draft, messageId)) === 'missing') {
      throw new Error('Its draft went missing before it was sent.');
    }
    left = 'its draft in Drafts, sent and not yet filed in Sent';
    const until = Date.now() + (filesSent ? HOST_FILING_MS : 0);
    while ((await provider.file(draft, messageId, Date.now() < until)) === 'unfiled') {
      await sleep(5000);
    }
    return { messageId };
  } catch (error) {
    if (left && error instanceof Error) error.message += ` It left ${left}.`;
    throw error;
  }
}

/** Watches the Inbox as the Mailroom does, then sends to self and waits to be told of it. */
async function watch(check: CheckRequest, provider: MailProvider) {
  let told = 0;
  let heard = () => {};
  const stop = provider.watch('INBOX', () => {
    told++;
    heard();
  });
  try {
    await sleep(check.watchSeconds * 1000);
    // News while nothing was sent, as a dropped connection gives when it reconnects.
    const toldWhileHeld = told;
    const announced = new Promise<number>((resolve) => (heard = () => resolve(Date.now())));
    const sentAt = Date.now();
    await sendToSelf(check, provider);
    const at = await Promise.race([
      announced,
      sleep(60_000).then(() => Promise.reject(new Error('No news of the new mail within 60s.'))),
    ]);
    return { toldWhileHeld, toldAfterMs: at - sentAt };
  } finally {
    stop();
  }
}

async function timed(check: string, run: () => Promise<unknown>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await run();
    return { check, ok: true, ms: Date.now() - start, detail };
  } catch (error) {
    // imapflow says only that a command failed, and keeps what the server said beside it.
    const e = error as Error & { code?: string; responseText?: string };
    const message = [e.code, e.message, e.responseText].filter(Boolean).join(' | ');
    return { check, ok: false, ms: Date.now() - start, error: message };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
