import {
  ImapFlow,
  type FetchMessageObject,
  type ImapTransport,
  type MailboxObject,
} from 'imapflow';
import { connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';
import nodemailer from 'nodemailer';
import type { SMTPTransportGetSocket } from 'nodemailer/lib/smtp-transport';
import PostalMime from 'postal-mime';
import type { AccountId, Flags, Folder, FolderRole, MessageRef } from '../../mail/core/index.ts';
import type { Cursor, MailProvider, Moved, SyncBatch, SyncWindow } from '../provider.ts';
import { envelopeOf, previewPartOf, type ImapMessage } from './core/envelope.ts';
import { flagsOf, planSync, type SyncPlan } from './core/sync.ts';

/** Where a host listens. Implicit TLS when `secure`, STARTTLS otherwise. */
export type Endpoint = { host: string; port: number; secure: boolean };

export type ImapAccount = {
  account: AccountId;
  imap: Endpoint;
  smtp: Endpoint;
  auth: { user: string; pass: string } | { user: string; accessToken: string };
  /** Whether the host files its own copy in Sent when it accepts a message, as Outlook does. */
  filesSent?: boolean;
};

/**
 * How the provider reaches the network. On workerd, the Mailroom passes imapflow's transport over
 * `cloudflare:sockets`, whose STARTTLS works there. Elsewhere Node's sockets serve, and `ca` adds
 * a certificate authority to trust, such as the test mail server's.
 */
export type Network = { imapTransport?: ImapTransport; ca?: string | Uint8Array };

/** How much of a text part a preview reads. HTML spends more of it on markup. */
const PREVIEW_BYTES = { text: 1024, html: 4096 };

/** How long a watcher waits to connect again after the server drops it. */
const WATCH_RETRY_MS = 2000;

/** The IMAP and SMTP provider. Vendors differ only in the account's hosts, sign-in and quirks. */
export function imapProvider(account: ImapAccount, network: Network = {}): MailProvider {
  const { account: id } = account;
  let client: Promise<ImapFlow> | undefined;
  let roles: Map<FolderRole, string> | undefined;
  const watchers = new Set<ImapFlow>();
  let closed = false;

  /** A watcher idles as soon as it can, and starts IDLE again every few minutes. */
  function open(watching = false): ImapFlow {
    const { host, port, secure } = account.imap;
    const connection = new ImapFlow({
      host,
      port,
      secure,
      doSTARTTLS: secure ? undefined : true,
      auth: account.auth,
      logger: false,
      ...(watching ? { autoIdleDelay: 100, maxIdleTime: 4 * 60_000 } : {}),
      ...(network.imapTransport ? { transport: network.imapTransport } : {}),
      ...(network.ca ? { tls: { ca: [toText(network.ca)] } } : {}),
    });
    // A dropped connection surfaces as a failed command, and the next command reconnects.
    connection.on('error', () => {});
    return connection;
  }

  /** The one connection commands share. It reconnects when the last one has dropped. */
  async function session(): Promise<ImapFlow> {
    if (closed) throw new Error('This provider is closed.');
    const current = client && (await client.catch(() => undefined));
    if (current?.usable) return current;
    client = (async () => {
      const connection = open();
      await connection.connect();
      return connection;
    })();
    return client;
  }

  /**
   * Runs `use` on the shared connection. When the server ends that connection under it, as Dovecot
   * does when a folder is renumbered, `use` runs once more on a new one: every command is safe to
   * repeat.
   */
  async function connected<T>(use: (connection: ImapFlow) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const connection = await session();
      try {
        return await use(connection);
      } catch (error) {
        if (attempt > 1 || connection.usable) throw error;
      }
    }
  }

  /** Runs `use` with `path` selected, so nothing else changes the selection meanwhile. */
  function inFolder<T>(
    path: string,
    use: (connection: ImapFlow, mailbox: MailboxObject) => Promise<T>,
  ) {
    return connected(async (connection) => {
      const lock = await connection.getMailboxLock(path);
      try {
        const mailbox = connection.mailbox;
        if (!mailbox) throw new Error(`${path} could not be selected`);
        return await use(connection, mailbox);
      } finally {
        lock.release();
      }
    });
  }

  /** The UIDs of these refs that still name messages in their folder, grouped by folder. */
  function byFolder(refs: MessageRef[]) {
    const groups = new Map<string, MessageRef[]>();
    for (const ref of refs) {
      if (ref.account !== id) continue;
      groups.set(ref.path, [...(groups.get(ref.path) ?? []), ref]);
    }
    return groups;
  }
  const current = (refs: MessageRef[], mailbox: MailboxObject) =>
    refs
      .filter((ref) => BigInt(ref.uidValidity) === BigInt(mailbox.uidValidity))
      .map((ref) => ref.uid);

  async function folderFor(role: FolderRole): Promise<string> {
    roles ??= new Map(
      (await provider.folders()).flatMap((f) => (f.role ? [[f.role, f.path] as const] : [])),
    );
    const path = roles.get(role);
    if (!path) throw new Error(`${account.auth.user} has no ${role} folder`);
    return path;
  }

  async function envelopes(
    connection: ImapFlow,
    path: string,
    uidValidity: number,
    uids: number[],
  ) {
    if (!uids.length) return [];
    const fetched: FetchMessageObject[] = [];
    for await (const message of connection.fetch(
      rangeOf(uids),
      {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        headers: ['references', 'list-id', 'list-unsubscribe'],
      },
      { uid: true },
    )) {
      fetched.push(message);
    }
    const previews = await previewsOf(connection, fetched);
    return fetched.map((message) =>
      envelopeOf({
        ref: { account: id, path, uidValidity, uid: message.uid },
        flags: flagsOf(message.flags ?? []),
        envelope: message.envelope ?? {},
        headers: message.headers?.toString('utf8') ?? '',
        ...(message.bodyStructure ? { structure: message.bodyStructure } : {}),
        ...(message.internalDate ? { internalDate: message.internalDate } : {}),
        previewText: previews.get(message.uid) ?? '',
      } satisfies ImapMessage),
    );
  }

  /** The decoded start of each message's preview part, fetched once per distinct part number. */
  async function previewsOf(connection: ImapFlow, messages: FetchMessageObject[]) {
    const wanted = new Map<string, { uids: number[]; html: boolean; header: string }>();
    for (const message of messages) {
      const preview = previewPartOf(message.bodyStructure);
      if (!preview) continue;
      const header =
        `Content-Type: ${preview.html ? 'text/html' : 'text/plain'}; charset="${preview.charset ?? 'utf-8'}"\r\n` +
        `Content-Transfer-Encoding: ${preview.encoding ?? '7bit'}\r\n\r\n`;
      const key = `${preview.part}\n${header}`;
      const entry = wanted.get(key) ?? { uids: [], html: preview.html, header };
      entry.uids.push(message.uid);
      wanted.set(key, entry);
    }
    const previews = new Map<number, string>();
    for (const [key, { uids, html, header }] of wanted) {
      const part = key.slice(0, key.indexOf('\n'));
      const maxLength = html ? PREVIEW_BYTES.html : PREVIEW_BYTES.text;
      for await (const message of connection.fetch(
        rangeOf(uids),
        { uid: true, bodyParts: [{ key: part, start: 0, maxLength }] },
        { uid: true },
      )) {
        const bytes = message.bodyParts?.get(part) ?? message.bodyParts?.get(part.toLowerCase());
        if (!bytes) continue;
        // The part's bytes under a header that names their type and encoding parse as a message.
        const parsed = await PostalMime.parse(concat(new TextEncoder().encode(header), bytes));
        previews.set(message.uid, (html ? parsed.html : parsed.text) ?? '');
      }
    }
    return previews;
  }

  async function flagsFor(connection: ImapFlow, plan: SyncPlan, inWindow: readonly number[]) {
    if (plan.flags === 'none' || !inWindow.length) return undefined;
    const flags = new Map<number, Flags>();
    const changedSince = plan.flags === 'all' ? undefined : plan.flags.changedSince;
    for await (const message of connection.fetch(
      changedSince === undefined ? rangeOf([...inWindow]) : '1:*',
      { uid: true, flags: true },
      { uid: true, ...(changedSince === undefined ? {} : { changedSince }) },
    )) {
      flags.set(message.uid, flagsOf(message.flags ?? []));
    }
    return flags;
  }

  function smtpSocket({ host, port, secure }: Endpoint): SMTPTransportGetSocket {
    const ca = network.ca ? { ca: [toText(network.ca)] } : {};
    return (_options, callback) => {
      // Opened by host name, so the certificate is checked against the name on every runtime.
      const socket = secure ? tls({ host, port, servername: host, ...ca }) : tcp({ host, port });
      socket.once(secure ? 'secureConnect' : 'connect', () =>
        callback(null, { connection: socket, secured: secure }),
      );
      socket.once('error', (error) => callback(error));
    };
  }

  async function submit(raw: Uint8Array, from: string, to: string[]) {
    const auth =
      'accessToken' in account.auth
        ? {
            type: 'OAuth2' as const,
            user: account.auth.user,
            accessToken: account.auth.accessToken,
          }
        : { user: account.auth.user, pass: account.auth.pass };
    const transport = nodemailer.createTransport({
      ...account.smtp,
      requireTLS: !account.smtp.secure,
      auth,
      getSocket: smtpSocket(account.smtp),
      ...(network.ca ? { tls: { ca: [toText(network.ca)] } } : {}),
    });
    try {
      await transport.sendMail({ envelope: { from, to }, raw: Buffer.from(raw) });
    } finally {
      transport.close();
    }
  }

  const provider: MailProvider = {
    async folders(): Promise<Folder[]> {
      const listed = await connected((connection) =>
        connection.list({ statusQuery: { messages: true, unseen: true } }),
      );
      return listed
        .filter((folder) => !folder.flags.has('\\Noselect') && !folder.flags.has('\\NonExistent'))
        .map((folder) => {
          const role = roleOf(folder.specialUse);
          return {
            account: id,
            path: folder.path,
            name: folder.name,
            ...(folder.parentPath ? { parent: folder.parentPath } : {}),
            ...(role ? { role } : {}),
            unread: folder.status?.unseen ?? 0,
            total: folder.status?.messages ?? 0,
          };
        });
    },

    sync(path: string, cursor: Cursor | null, window: SyncWindow): Promise<SyncBatch> {
      return inFolder(path, async (connection) => {
        // Selected again, because a session sees what arrived since it selected the folder only
        // once the server catches it up, and UIDNEXT and HIGHESTMODSEQ only from a fresh SELECT.
        const mailbox = await connection.mailboxOpen(path);
        const found = await connection.search({ since: new Date(window.since) }, { uid: true });
        const inWindow = Array.isArray(found) ? found : [];
        const uidValidity = Number(mailbox.uidValidity);
        // Dovecot reports HIGHESTMODSEQ on a SELECT even to a session without CONDSTORE, once the
        // folder has kept modseqs. Without CONDSTORE nothing can be fetched by it, so it counts
        // only when the session has CONDSTORE turned on.
        const condstore =
          connection.enabled.has('CONDSTORE') && mailbox.highestModseq !== undefined;
        const plan = planSync({ account: id, path }, cursor, {
          uidValidity,
          uidNext: mailbox.uidNext,
          ...(condstore ? { highestModSeq: BigInt(mailbox.highestModseq ?? 0) } : {}),
          inWindow,
        });
        const fetched = await envelopes(connection, path, uidValidity, plan.envelopes);
        const flags = await flagsFor(connection, plan, inWindow);
        return plan.reconcile({ envelopes: fetched, ...(flags ? { flags } : {}) });
      });
    },

    async body(ref: MessageRef) {
      const source = await inFolder(ref.path, async (connection, mailbox) => {
        const [uid] = current([ref], mailbox);
        if (uid === undefined) return undefined;
        const fetch = () => connection.fetchOne(String(uid), { source: true }, { uid: true });
        // A message that arrived after this session last heard from the server needs a NOOP first.
        let message = await fetch();
        if (!message) {
          await connection.noop();
          message = await fetch();
        }
        return message ? message.source : undefined;
      });
      if (!source) throw new Error('The message is no longer on the server');
      return new Blob([new Uint8Array(source)]).stream();
    },

    async setFlags(refs: MessageRef[], change: Partial<Flags>) {
      const names = {
        seen: '\\Seen',
        flagged: '\\Flagged',
        answered: '\\Answered',
        draft: '\\Draft',
      } as const;
      const add = Object.entries(change)
        .filter(([, on]) => on === true)
        .map(([flag]) => names[flag as keyof Flags]);
      const remove = Object.entries(change)
        .filter(([, on]) => on === false)
        .map(([flag]) => names[flag as keyof Flags]);
      for (const [path, group] of byFolder(refs)) {
        await inFolder(path, async (connection, mailbox) => {
          const uids = current(group, mailbox);
          if (!uids.length) return;
          if (add.length) await connection.messageFlagsAdd(rangeOf(uids), add, { uid: true });
          if (remove.length)
            await connection.messageFlagsRemove(rangeOf(uids), remove, { uid: true });
        });
      }
    },

    /**
     * With UIDPLUS, the server says where each message landed. Without it, their Message-IDs are
     * read first and found again where they landed.
     */
    async move(refs: MessageRef[], to: string) {
      const moved: Moved[] = [];
      for (const [path, group] of byFolder(refs)) {
        if (path === to) continue;
        const done = await inFolder(path, async (connection, mailbox) => {
          const uids = current(group, mailbox);
          if (!uids.length) return undefined;
          const uidplus = connection.capabilities.has('UIDPLUS');
          const ids = uidplus ? new Map<number, string>() : await messageIdsOf(connection, uids);
          const result = await connection.messageMove(rangeOf(uids), to, { uid: true });
          if (!result) throw new Error(`The server would not move those messages to ${to}.`);
          return { uidplus, ids, result };
        });
        if (!done) continue;
        const from = (uid: number) => group.find((ref) => ref.uid === uid);
        const { uidMap, uidValidity } = done.result;
        if (done.uidplus && uidMap && uidValidity !== undefined) {
          for (const [was, landed] of uidMap) {
            const ref = from(was);
            if (ref) moved.push({ from: ref, to: refIn(to, uidValidity, landed) });
          }
          continue;
        }
        const found = await inFolder(to, async (connection, mailbox) => {
          const pairs: Moved[] = [];
          for (const [was, messageId] of done.ids) {
            const ref = from(was);
            const landed = await uidOf(connection, messageId);
            if (ref && landed !== undefined) {
              pairs.push({ from: ref, to: refIn(to, mailbox.uidValidity, landed) });
            }
          }
          return pairs;
        });
        moved.push(...found);
      }
      return moved;
    },

    async saveDraft(message: Uint8Array, replaces?: MessageRef) {
      const drafts = await folderFor('drafts');
      const { appended, uidplus } = await connected(async (connection) => ({
        appended: await connection.append(drafts, Buffer.from(message), ['\\Draft', '\\Seen']),
        uidplus: connection.capabilities.has('UIDPLUS'),
      }));
      // Without UIDPLUS the server doesn't say where it filed the draft, so its Message-ID finds it.
      const filed =
        uidplus && appended && appended.uid !== undefined && appended.uidValidity !== undefined
          ? refIn(drafts, appended.uidValidity, appended.uid)
          : await inFolder(drafts, async (connection, mailbox) => {
              const messageId = (await PostalMime.parse(message)).messageId;
              const uid = messageId ? await uidOf(connection, messageId) : undefined;
              return uid === undefined ? undefined : refIn(drafts, mailbox.uidValidity, uid);
            });
      if (!filed) throw new Error('The server did not say where it filed the draft');
      if (replaces) await remove(replaces);
      return filed;
    },

    async send(draft: MessageRef) {
      const source = await inFolder(draft.path, async (connection, mailbox) => {
        const [uid] = current([draft], mailbox);
        if (uid === undefined) return undefined;
        const message = await connection.fetchOne(String(uid), { source: true }, { uid: true });
        return message ? new Uint8Array(message.source ?? []) : undefined;
      });
      // A draft that is gone was sent, or removed, already.
      if (!source?.length) return;

      const parsed = await PostalMime.parse(source);
      const messageId = parsed.messageId ?? '';
      const sent = await folderFor('sent');
      const filed = messageId
        ? await inFolder(sent, async (connection) => {
            const found = await connection.search(
              { header: { 'message-id': messageId } },
              { uid: true },
            );
            return Array.isArray(found) && found.length > 0;
          })
        : false;

      if (!filed) {
        const recipients = [
          ...(parsed.to ?? []),
          ...(parsed.cc ?? []),
          ...(parsed.bcc ?? []),
        ].flatMap((a) => (a.group ? a.group.map((m) => m.address) : [a.address]));
        const from = parsed.from && !parsed.from.group ? parsed.from.address : account.auth.user;
        // Bcc recipients get the message, but no copy says who they were.
        const outgoing = withoutHeader(source, 'bcc');
        await submit(outgoing, from, recipients);
        if (!account.filesSent) {
          await connected((connection) =>
            connection.append(sent, Buffer.from(outgoing), ['\\Seen']),
          );
        }
      }
      await remove(draft);
    },

    async search(path: string, text: string) {
      return inFolder(path, async (connection) => {
        const found = await connection.search({ text }, { uid: true });
        return Array.isArray(found) ? found : [];
      });
    },

    /**
     * Watches on a connection of its own. When the server drops it, the watcher connects again a
     * few seconds later and reports a change, since whatever happened in between went unheard.
     */
    watch(path: string, onChange: () => void) {
      let stopped = false;
      let connection: ImapFlow | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        if (!stopped) onChange();
      };
      const begin = (again: boolean) => {
        if (stopped || closed) return;
        const watching = open(true);
        connection = watching;
        watchers.add(watching);
        watching.on('exists', changed);
        watching.on('expunge', changed);
        watching.on('flags', changed);
        watching.once('close', () => {
          watchers.delete(watching);
          if (!stopped && !closed) retry = setTimeout(() => begin(true), WATCH_RETRY_MS);
        });
        void (async () => {
          try {
            await watching.connect();
            await watching.mailboxOpen(path);
            if (again) changed();
            await watching.idle();
          } catch {
            // The connection closes, and the watcher tries again. The Mailroom polls meanwhile.
            watching.close();
          }
        })();
      };
      begin(false);
      return () => {
        stopped = true;
        clearTimeout(retry);
        const watching = connection;
        if (!watching) return;
        watchers.delete(watching);
        void watching.logout().catch(() => watching.close());
      };
    },

    async createFolder(path: string) {
      await connected(async (connection) => {
        if ((await connection.list()).some((folder) => folder.path === path)) return;
        await connection.mailboxCreate(path);
      });
      roles = undefined;
    },

    async renameFolder(path: string, to: string) {
      await connected(async (connection) => {
        const paths = new Set((await connection.list()).map((folder) => folder.path));
        if (!paths.has(path) && paths.has(to)) return;
        await connection.mailboxRename(path, to);
      });
      roles = undefined;
    },

    async deleteFolder(path: string) {
      await connected(async (connection) => {
        if (!(await connection.list()).some((folder) => folder.path === path)) return;
        await connection.mailboxDelete(path);
      });
      roles = undefined;
    },

    async close() {
      closed = true;
      const shared = client ? await client.catch(() => undefined) : undefined;
      const connections = [...watchers, ...(shared ? [shared] : [])];
      watchers.clear();
      client = undefined;
      await Promise.all(connections.map((c) => c.logout().catch(() => c.close())));
    },
  };

  /** Removes one message for good. Its folder may have no Trash to move it to. */
  const refIn = (path: string, uidValidity: bigint | number, uid: number): MessageRef => ({
    account: id,
    path,
    uidValidity: Number(uidValidity),
    uid,
  });

  async function remove(ref: MessageRef) {
    await inFolder(ref.path, async (connection, mailbox) => {
      const uids = current([ref], mailbox);
      if (uids.length) await connection.messageDelete(rangeOf(uids), { uid: true });
    });
  }

  return provider;
}

const ROLES: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Archive': 'archive',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
};
const roleOf = (specialUse: string | undefined) => (specialUse ? ROLES[specialUse] : undefined);

/** Ascending UIDs as an IMAP sequence set, with runs collapsed, so a long list stays short. */
/** The Message-IDs of messages in the selected folder, by UID. */
async function messageIdsOf(connection: ImapFlow, uids: number[]): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for await (const message of connection.fetch(rangeOf(uids), { envelope: true }, { uid: true })) {
    const messageId = message.envelope?.messageId;
    if (messageId) ids.set(message.uid, messageId);
  }
  return ids;
}

/** The UID of the message with this Message-ID in the selected folder, the newest if several. */
async function uidOf(connection: ImapFlow, messageId: string): Promise<number | undefined> {
  const found = await connection.search({ header: { 'message-id': messageId } }, { uid: true });
  return Array.isArray(found) && found.length ? Math.max(...found) : undefined;
}

export function rangeOf(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length;) {
    const start = sorted[i]!;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i]!;
    runs.push(start === end ? String(start) : `${start}:${end}`);
    i++;
  }
  return runs.join(',');
}

/** The message without one header, folded continuation lines included. The body is untouched. */
function withoutHeader(message: Uint8Array, name: string): Uint8Array {
  const text = new TextDecoder('latin1').decode(message);
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const kept = head.replace(new RegExp(`^${name}:.*(?:\\r?\\n[ \\t].*)*(?:\\r?\\n|$)`, 'gim'), '');
  return latin1(kept + (end < 0 ? '' : text.slice(end)));
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

function toText(ca: string | Uint8Array) {
  return typeof ca === 'string' ? ca : new TextDecoder().decode(ca);
}
