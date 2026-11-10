// The check Worker. A Durable Object runs the mail checks the Mailroom depends on, on the Workers
// runtime, against one account. The secret arrives in the request body and lives only for that
// request: nothing here stores, logs or returns it, and no mail content leaves the object.
import { connect } from 'cloudflare:sockets';
import { ImapFlow, createSocketsTransport } from 'imapflow';
import { connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';
import nodemailer from 'nodemailer';
import type { SMTPTransportGetSocket } from 'nodemailer/lib/smtp-transport';

export type Endpoint = { host: string; port: number; secure: boolean };

export type CheckRequest = {
  user: string;
  secret: string;
  auth: 'password' | 'oauth';
  imap: Endpoint;
  smtp: Endpoint[];
  /** How long to hold IDLE before sending to self and waiting to be told. Zero skips the watch. */
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

export default {
  async fetch(request: Request, env: { CHECK: Namespace }): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/run') {
      return new Response(null, { status: 404 });
    }
    return env.CHECK.get(env.CHECK.newUniqueId()).fetch(request);
  },
};

export class Check {
  async fetch(request: Request): Promise<Response> {
    const check = (await request.json()) as CheckRequest;
    const results = [
      await timed(`list folders and fetch a message over ${check.imap.port}`, () =>
        listAndFetch(check),
      ),
    ];
    for (const endpoint of check.smtp) {
      const label = `${endpoint.port} (${endpoint.secure ? 'implicit TLS' : 'STARTTLS'})`;
      results.push(
        await timed(`send to self over ${label}`, () =>
          sendToSelf(check, endpoint, `Trail Mix check over ${label}`),
        ),
      );
    }
    if (check.watchSeconds > 0) {
      results.push(
        await timed(`watch INBOX for ${check.watchSeconds}s, then see new mail`, () =>
          watch(check),
        ),
      );
    }
    return Response.json({ runtime: navigator.userAgent, results });
  }
}

async function listAndFetch(check: CheckRequest) {
  const client = imap(check);
  await client.connect();
  try {
    const folders = (await client.list()).map((f) =>
      f.specialUse ? `${f.path} ${f.specialUse}` : f.path,
    );
    const lock = await client.getMailboxLock('INBOX');
    try {
      const newest = await client.fetchOne('*', { uid: true, size: true });
      return {
        capabilities: [...client.capabilities.keys()],
        folders,
        newest: newest ? { uid: newest.uid, size: newest.size } : null,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// One message from the account to itself, so a check never mails anyone else.
async function sendToSelf(check: CheckRequest, endpoint: Endpoint, subject: string) {
  const transport = nodemailer.createTransport({
    ...endpoint,
    requireTLS: !endpoint.secure,
    auth:
      check.auth === 'oauth'
        ? { type: 'OAuth2', user: check.user, accessToken: check.secret }
        : { user: check.user, pass: check.secret },
    getSocket: socketByName(endpoint),
  });
  try {
    const info = await transport.sendMail({
      from: check.user,
      to: check.user,
      subject,
      text: `${subject}\n\nSent by Trail Mix's mail check. Delete it at will.`,
    });
    return { response: info.response };
  } finally {
    transport.close();
  }
}

// Holds IDLE across the wait, then sends to self and waits for the server to announce it.
async function watch(check: CheckRequest) {
  const client = imap(check);
  let closed = false;
  client.on('close', () => (closed = true));
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const idling = client.idle();
    const openedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, check.watchSeconds * 1000));
    if (closed) throw new Error('the connection closed during the watch');
    const announced = new Promise<void>((resolve) => client.once('exists', () => resolve()));
    const sentAt = Date.now();
    const endpoint = check.smtp[0];
    if (!endpoint) throw new Error('no submission endpoint to send with');
    await sendToSelf(check, endpoint, `Trail Mix watch check ${new Date().toISOString()}`);
    await Promise.race([
      announced,
      rejectAfter(60_000, 'the server announced no new mail within 60s'),
    ]);
    const result = {
      heldSeconds: Math.round((sentAt - openedAt) / 1000),
      announcedAfterMs: Date.now() - sentAt,
    };
    await client.logout();
    await idling.catch(() => {});
    return result;
  } finally {
    client.close();
  }
}

// imapflow always goes through `cloudflare:sockets`. Its default path fails STARTTLS on workerd.
function imap(check: CheckRequest) {
  const { host, port, secure } = check.imap;
  return new ImapFlow({
    host,
    port,
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth:
      check.auth === 'oauth'
        ? { user: check.user, accessToken: check.secret }
        : { user: check.user, pass: check.secret },
    logger: false,
    transport: createSocketsTransport(connect),
  });
}

// nodemailer always gets a socket opened by host name. Left to resolve names itself, it connects to
// an address, and workerd then checks the certificate against that address instead of the name.
function socketByName({ host, port, secure }: Endpoint): SMTPTransportGetSocket {
  return (_options, callback) => {
    const socket = secure ? tls({ host, port, servername: host }) : tcp({ host, port });
    socket.once(secure ? 'secureConnect' : 'connect', () =>
      callback(null, { connection: socket, secured: secure }),
    );
    socket.once('error', (error) => callback(error));
  };
}

async function timed(check: string, run: () => Promise<unknown>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await run();
    return { check, ok: true, ms: Date.now() - start, detail };
  } catch (error) {
    const e = error as Error & { code?: string; response?: string; responseText?: string };
    const message = [e.code, e.message, e.responseText ?? e.response].filter(Boolean).join(' | ');
    return { check, ok: false, ms: Date.now() - start, error: message };
  }
}

function rejectAfter(ms: number, message: string) {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
