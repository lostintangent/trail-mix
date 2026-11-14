import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type ImapTransport,
  type MailboxObject,
} from 'imapflow';
import { connect as tcp, type Socket } from 'node:net';
import { connect as tls } from 'node:tls';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { SMTPTransportGetSocket } from 'nodemailer/lib/smtp-transport';
import PostalMime from 'postal-mime';
import {
  messageIdOf,
  type AccountId,
  type Flags,
  type Folder,
  type FolderRole,
  type MessageRef,
} from '../../mail/core/index.ts';
import {
  SEARCH_LIMIT,
  SendFailure,
  beforeSending,
  type Cursor,
  type MailProvider,
  type Moved,
  type SyncBatch,
  type SyncWindow,
} from '../provider.ts';
import {
  envelopeOf,
  previewPartsOf,
  type ImapMessage,
  type PreviewPart,
  type Previews,
} from './core/envelope.ts';
import { previewOf } from './core/preview.ts';
import { flagsOf, planSync, type SyncPlan } from './core/sync.ts';
import { subtree } from './core/folders.ts';
import type { Endpoint } from './core/presets.ts';
import { submitFailure } from './core/send.ts';
import { signInFailure, type SentCredentials } from './core/signin.ts';

export type ImapAccount = {
  account: AccountId;
  imap: Endpoint;
  smtp: Endpoint;
  /**
   * How the account signs in: a password, or an access token, asked for again for each new
   * connection, so a token that has run out costs only a reconnect.
   */
  auth: { user: string; pass: string } | { user: string; accessToken: () => Promise<string> };
  /**
   * Whether the host files its own copy in Sent of a message it accepts, as Zoho and Outlook do,
   * perhaps a while after. Filing then leaves Sent to the host while the Outbox waits for it.
   */
  filesSent?: boolean;
  /**
   * The names the host signs Authentication-Results with, as its preset gives them, under which the
   * topmost one says whether a sender passed DMARC. Without any, no message counts as verified.
   */
  authServers?: readonly string[];
};

/**
 * How the provider reaches the network. On workerd, the Mailroom passes imapflow's transport over
 * `cloudflare:sockets`, whose STARTTLS works there. Elsewhere Node's sockets serve, and `ca` adds
 * a certificate authority to trust, such as the test mail server's. `patience` stands in for
 * `SMTP_PATIENCE_MS` and `IMAP_PATIENCE_MS`, so a test of a host gone quiet need not wait as long.
 * `spent` hears where the time of each use of the IMAP connection went.
 */
export type Network = {
  imapTransport?: ImapTransport;
  ca?: string | Uint8Array;
  patience?: number;
  spent?: (part: ImapPart, ms: number) => void;
};

/**
 * A part of one use of the IMAP connection: `connect` waits for it to be open and signed in,
 * `imap` is the time on it after that, and `folder` is the part of `imap` spent waiting to have a
 * folder selected, behind whatever else holds the connection's folder.
 */
export type ImapPart = 'connect' | 'imap' | 'folder';

/**
 * How long a send waits on an SMTP host that has gone quiet: to connect, for its greeting, and for
 * each reply. Sends run in the Mailroom's wake, ahead of sync, and without this a host that stalls
 * would hold them for nodemailer's ten minutes, or for good if it stalls during TLS.
 */
const SMTP_PATIENCE_MS = 60_000;

/**
 * How long a command waits on an IMAP host that has gone quiet before its connection is given up
 * and the command runs once more on a new one. Opening a message, saving a draft and each sync
 * step share one connection, and one the network dropped without a word would hold them all for
 * imapflow's five minutes.
 */
const IMAP_PATIENCE_MS = 30_000;

/** How much of a text part a preview reads. HTML spends more of it on markup. */
const PREVIEW_BYTES = { text: 1024, html: 4096 };

/** How long a watcher waits to connect again after the server drops it. */
const WATCH_RETRY_MS = 2000;

/**
 * How many of Sent's newest messages are read when looking for a copy by its Message-ID. A host's
 * search may not yet know a copy it just filed, but the copy is among the newest.
 */
const NEWEST_IN_SENT = 50;

/** The IMAP and SMTP provider. Vendors differ only in the account's hosts, sign-in and quirks. */
export function imapProvider(account: ImapAccount, network: Network = {}): MailProvider {
  const { account: id } = account;
  let client: Promise<ImapFlow> | undefined;
  let roles: Map<FolderRole, string> | undefined;
  const watchers = new Set<ImapFlow>();
  let closed = false;

  /**
   * The shared connection waits on a host gone quiet only as long as its patience. A watcher idles
   * as soon as it can, and starts IDLE again every few minutes.
   */
  function open(watching = false): Promise<ImapFlow> {
    return imapConnection(
      account,
      network,
      watching
        ? { autoIdleDelay: 100, maxIdleTime: 4 * 60_000 }
        : { socketTimeout: network.patience ?? IMAP_PATIENCE_MS },
    );
  }

  /** The one connection commands share. It reconnects when the last one has dropped. */
  async function session(): Promise<ImapFlow> {
    if (closed) throw new Error('This provider is closed.');
    const current = client && (await client.catch(() => undefined));
    if (current?.usable) return current;
    client = (async () => {
      const connection = await open();
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
      const asked = Date.now();
      const connection = await session();
      const opened = Date.now();
      network.spent?.('connect', opened - asked);
      try {
        return await use(connection);
      } catch (error) {
        if (attempt > 1 || connection.usable) throw error;
      } finally {
        network.spent?.('imap', Date.now() - opened);
      }
    }
  }

  /** Runs `use` with `path` selected, so nothing else changes the selection meanwhile. */
  function inFolder<T>(
    path: string,
    use: (connection: ImapFlow, mailbox: MailboxObject) => Promise<T>,
  ) {
    return connected(async (connection) => {
      const asked = Date.now();
      const lock = await connection.getMailboxLock(path);
      network.spent?.('folder', Date.now() - asked);
      try {
        const mailbox = connection.mailbox;
        if (!mailbox) throw new Error(`${path} could not be selected`);
        return await use(connection, mailbox);
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Runs `use` with `path` selected afresh. A session sees what arrived since it selected a folder
   * only once the server catches it up, so whatever must see the folder as it is now selects again.
   */
  function inFresh<T>(
    path: string,
    use: (connection: ImapFlow, mailbox: MailboxObject) => Promise<T>,
  ) {
    return inFolder(path, async (connection) =>
      use(connection, await connection.mailboxOpen(path)),
    );
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
        headers: ['references', 'list-id', 'list-unsubscribe', 'authentication-results'],
      },
      { uid: true },
    )) {
      fetched.push(message);
    }
    const previews = await previewsOf(connection, fetched);
    return fetched.map((message) =>
      envelopeOf(
        {
          ref: { account: id, path, uidValidity, uid: message.uid },
          flags: flagsOf(message.flags ?? []),
          envelope: message.envelope ?? {},
          headers: message.headers?.toString('utf8') ?? '',
          ...(message.bodyStructure ? { structure: message.bodyStructure } : {}),
          ...(message.internalDate ? { internalDate: message.internalDate } : {}),
          previews: previews.get(message.uid) ?? {},
        } satisfies ImapMessage,
        account.authServers ?? [],
      ),
    );
  }

  /**
   * The decoded start of each message's preview parts: its plain text, and its HTML where there is
   * no plain text or it has no words to read, as a newsletter's often hasn't.
   */
  async function previewsOf(connection: ImapFlow, messages: FetchMessageObject[]) {
    const previews = new Map<number, Previews>();
    const parts = new Map(
      messages.map(({ uid, bodyStructure }) => [uid, previewPartsOf(bodyStructure)]),
    );
    const plain = await startsOf(
      connection,
      [...parts].flatMap(([uid, { plain }]) => (plain ? [{ uid, ...plain }] : [])),
      false,
    );
    for (const [uid, text] of plain) previews.set(uid, { plain: text });
    const html = await startsOf(
      connection,
      [...parts].flatMap(([uid, { html }]) => {
        const read = plain.get(uid);
        return html && (read === undefined || !previewOf(read, false)) ? [{ uid, ...html }] : [];
      }),
      true,
    );
    for (const [uid, text] of html) previews.set(uid, { ...previews.get(uid), html: text });
    return previews;
  }

  /** The decoded start of each message's part, fetched once per distinct part number. */
  async function startsOf(
    connection: ImapFlow,
    wanted: readonly (PreviewPart & { uid: number })[],
    html: boolean,
  ) {
    const byPart = Map.groupBy(
      wanted,
      ({ part, charset, encoding }) => `${part}\n${charset ?? 'utf-8'}\n${encoding ?? '7bit'}`,
    );
    const starts = new Map<number, string>();
    for (const [key, messages] of byPart) {
      const [part = '', charset, encoding] = key.split('\n');
      const header =
        `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset="${charset}"\r\n` +
        `Content-Transfer-Encoding: ${encoding}\r\n\r\n`;
      const maxLength = html ? PREVIEW_BYTES.html : PREVIEW_BYTES.text;
      for await (const message of connection.fetch(
        rangeOf(messages.map(({ uid }) => uid)),
        { uid: true, bodyParts: [{ key: part, start: 0, maxLength }] },
        { uid: true },
      )) {
        const bytes = message.bodyParts?.get(part) ?? message.bodyParts?.get(part.toLowerCase());
        if (!bytes) continue;
        // The part's bytes under a header that names their type and encoding parse as a message.
        const parsed = await PostalMime.parse(concat(new TextEncoder().encode(header), bytes));
        starts.set(message.uid, (html ? parsed.html : parsed.text) ?? '');
      }
    }
    return starts;
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

  /**
   * Hands a message to the host over SMTP, and rejects with what a failure means for trying again.
   * The transaction log says when the server gave the go-ahead for the body, after which a lost
   * connection may have delivered it.
   */
  async function deliver(raw: Uint8Array, from: string, to: string[]) {
    let bodySent = false;
    const transport = await smtpTransport(account, network, {
      transactionLog: true,
      logger: {
        debug(entry: { tnx?: string } | undefined, line: unknown) {
          if (entry?.tnx === 'server' && /^354\b/.test(String(line))) bodySent = true;
        },
      },
    });
    try {
      await transport.sendMail({ envelope: { from, to }, raw: Buffer.from(raw) });
    } catch (error) {
      const { error: reason, passing } = submitFailure(
        error as Parameters<typeof submitFailure>[0],
        bodySent,
        account.smtp.host,
      );
      throw new SendFailure(reason, passing);
    } finally {
      transport.close();
    }
  }

  /** The raw draft a ref names, or nothing once it is gone. */
  function draftSource(draft: MessageRef) {
    return inFolder(draft.path, async (connection, mailbox) => {
      const [uid] = current([draft], mailbox);
      if (uid === undefined) return undefined;
      const message = await connection.fetchOne(String(uid), { source: true }, { uid: true });
      return message && message.source?.length ? new Uint8Array(message.source) : undefined;
    });
  }

  /** Whether Sent holds a message with this Message-ID, by search or among its newest. */
  async function inSent(messageId: string) {
    if (!messageId) return false;
    return inFresh(await folderFor('sent'), async (connection, mailbox) => {
      if ((await uidOf(connection, messageId)) !== undefined) return true;
      if (!mailbox.exists) return false;
      const newest = `${Math.max(1, mailbox.exists - NEWEST_IN_SENT + 1)}:*`;
      for await (const message of connection.fetch(newest, { envelope: true })) {
        if (messageIdOf(message.envelope?.messageId) === messageId) return true;
      }
      return false;
    });
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
            // A server whose folders can't nest lists NIL.
            ...(folder.delimiter ? { delimiter: folder.delimiter } : {}),
            ...(role ? { role } : {}),
            unread: folder.status?.unseen ?? 0,
            total: folder.status?.messages ?? 0,
          };
        });
    },

    sync(path: string, cursor: Cursor | null, window: SyncWindow): Promise<SyncBatch> {
      // UIDNEXT and HIGHESTMODSEQ, too, come only from a fresh SELECT.
      return inFresh(path, async (connection, mailbox) => {
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
          const range = rangeOf(uids);
          if (add.length) {
            await unlessRefused(connection, 'change those flags', () =>
              connection.messageFlagsAdd(range, add, { uid: true }),
            );
          }
          if (remove.length) {
            await unlessRefused(connection, 'change those flags', () =>
              connection.messageFlagsRemove(range, remove, { uid: true }),
            );
          }
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
          const result = await unlessRefused(connection, `move those messages to ${to}`, () =>
            connection.messageMove(rangeOf(uids), to, { uid: true }),
          );
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
        const found = await inFresh(to, async (connection, mailbox) => {
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

    async saveDraft(message: Uint8Array) {
      const drafts = await folderFor('drafts');
      const { appended, uidplus } = await connected(async (connection) => ({
        appended: await connection.append(drafts, Buffer.from(message), ['\\Draft', '\\Seen']),
        uidplus: connection.capabilities.has('UIDPLUS'),
      }));
      // Without UIDPLUS the server doesn't say where it filed the draft, so its Message-ID finds it.
      const filed =
        uidplus && appended && appended.uid !== undefined && appended.uidValidity !== undefined
          ? refIn(drafts, appended.uidValidity, appended.uid)
          : await inFresh(drafts, async (connection, mailbox) => {
              const messageId = (await PostalMime.parse(message)).messageId;
              const uid = messageId ? await uidOf(connection, messageId) : undefined;
              return uid === undefined ? undefined : refIn(drafts, mailbox.uidValidity, uid);
            });
      if (!filed) throw new Error('The server did not say where it filed the draft');
      return filed;
    },

    async discardDraft(draft: MessageRef) {
      if (draft.path === (await folderFor('drafts'))) await remove(draft);
    },

    async submit(draft: MessageRef, messageId: string) {
      const source = await beforeSending(async () =>
        (await inSent(messageId)) ? ('sent' as const) : ((await draftSource(draft)) ?? 'missing'),
      );
      if (typeof source === 'string') return source;
      const parsed = await PostalMime.parse(source);
      const recipients = [
        ...(parsed.to ?? []),
        ...(parsed.cc ?? []),
        ...(parsed.bcc ?? []),
      ].flatMap((a) => (a.group ? a.group.map((m) => m.address) : [a.address]));
      const from = parsed.from && !parsed.from.group ? parsed.from.address : account.auth.user;
      // Bcc recipients get the message, but no copy says who they were.
      await deliver(withoutHeader(source, 'bcc'), from, recipients);
      return 'sent';
    },

    async file(draft: MessageRef, messageId: string, waitForHost: boolean) {
      return beforeSending(async () => {
        const source = await draftSource(draft);
        if (!source) return 'filed' as const;
        if (!(await inSent(messageId))) {
          if (account.filesSent && waitForHost) return 'unfiled' as const;
          const sent = await folderFor('sent');
          const copy = Buffer.from(withoutHeader(source, 'bcc'));
          await connected((connection) => connection.append(sent, copy, ['\\Seen']));
        }
        await remove(draft);
        return 'filed' as const;
      });
    },

    async search(path: string, text: string) {
      return inFresh(path, async (connection, mailbox) => {
        const found = await connection.search({ text }, { uid: true });
        const newest = (Array.isArray(found) ? found : [])
          .sort((a, b) => b - a)
          .slice(0, SEARCH_LIMIT);
        const hits = await envelopes(connection, path, Number(mailbox.uidValidity), newest);
        return hits.sort((a, b) => b.date.localeCompare(a.date) || b.uid - a.uid);
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
      const again = () => {
        if (!stopped && !closed) retry = setTimeout(() => void begin(true), WATCH_RETRY_MS);
      };
      const begin = async (reconnecting: boolean) => {
        if (stopped || closed) return;
        let watching: ImapFlow;
        try {
          watching = await open(true);
        } catch {
          // No way to sign in just now. The watcher tries again, and the Mailroom polls meanwhile.
          return again();
        }
        if (stopped || closed) return watching.close();
        connection = watching;
        watchers.add(watching);
        watching.on('exists', changed);
        watching.on('expunge', changed);
        watching.on('flags', changed);
        watching.once('close', () => {
          watchers.delete(watching);
          again();
        });
        try {
          await watching.connect();
          await watching.mailboxOpen(path);
          if (reconnecting) changed();
          await watching.idle();
        } catch {
          // The connection closes, and the watcher tries again. The Mailroom polls meanwhile.
          watching.close();
        }
      };
      void begin(false);
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
        const listed = await connection.list();
        const delimiter = listed.find((folder) => folder.path === path)?.delimiter;
        for (const doomed of subtree(listed, path, delimiter))
          await connection.mailboxDelete(doomed);
        // Some servers answer a parent's delete with OK and keep it, as Dovecot does while a folder
        // is inside it, so only a listing without them says they're gone.
        const [left] = subtree(await connection.list(), path, delimiter);
        if (left !== undefined) {
          throw new Error(`The server still has “${left}”, so “${path}” wasn’t deleted.`);
        }
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
      if (!uids.length) return;
      await unlessRefused(connection, 'remove that message', () =>
        connection.messageDelete(rangeOf(uids), { uid: true }),
      );
    });
  }

  return provider;
}

/**
 * Signs in to the account's IMAP host, then to its SMTP host, and out of each again, sending
 * nothing. Rejects with why a host turned it away, in its own words when it gave any. Each host has
 * `SIGN_IN_PATIENCE_MS` to connect, greet and take the password, so a mistyped host is told soon.
 */
export async function checkSignIn(account: ImapAccount, network: Network = {}): Promise<void> {
  const { auth } = account;
  // What was sent, so no part of it is in a reason a host gives.
  const sent: SentCredentials =
    'pass' in auth
      ? { user: auth.user, by: 'password', secrets: [auth.pass] }
      : { user: auth.user, by: 'token', secrets: [] };
  const signingIn: ImapAccount =
    'pass' in auth
      ? account
      : {
          ...account,
          auth: {
            user: auth.user,
            accessToken: async () => {
              const token = await auth.accessToken();
              sent.secrets.push(token);
              return token;
            },
          },
        };
  // Only the reason leaves, never the client's error, which may carry what was sent. A token that
  // can't be had is not a host's refusal, so it rejects as it was.
  const refusal = (endpoint: Endpoint) => (error: SignInError) =>
    signInFailure(error, endpoint, sent);

  const connection = await imapConnection(signingIn, network);
  const imap = await inTime(connection.connect(), () => connection.close()).then(
    () => undefined,
    refusal(account.imap),
  );
  if (imap) throw new Error(imap);
  await connection.logout().catch(() => connection.close());

  const sockets: Socket[] = [];
  const patient = { ...network, patience: SIGN_IN_PATIENCE_MS };
  const transport = await smtpTransport(signingIn, patient, {}, (socket) => sockets.push(socket));
  const smtp = await inTime(transport.verify(), () => {
    for (const socket of sockets) socket.destroy();
  }).then(() => undefined, refusal(account.smtp));
  transport.close();
  if (smtp) throw new Error(smtp);
}

/** How long a host has to connect, greet and take a password, when an account is added. */
export const SIGN_IN_PATIENCE_MS = 15_000;

/**
 * `attempt`, unless it outlasts a sign-in's patience. Then `stop` ends it, and it fails as a host
 * that never answered.
 */
async function inTime<T>(attempt: Promise<T>, stop: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop();
      reject(Object.assign(new Error('It didn’t answer.'), { code: 'ETIMEDOUT' }));
    }, SIGN_IN_PATIENCE_MS);
  });
  try {
    return await Promise.race([attempt, late]);
  } finally {
    clearTimeout(timer);
  }
}

type SignInError = Parameters<typeof signInFailure>[0];

/**
 * A transport to the account's SMTP host, signed in as the account, that waits on a host gone
 * quiet only as long as the network's patience.
 */
async function smtpTransport(
  account: ImapAccount,
  network: Network,
  log: Pick<SMTPTransport.Options, 'transactionLog' | 'logger'> = {},
  opened?: (socket: Socket) => void,
) {
  const patience = network.patience ?? SMTP_PATIENCE_MS;
  const signedIn = await credentialsOf(account.auth);
  const auth =
    'accessToken' in signedIn ? { type: 'OAuth2' as const, ...signedIn } : { ...signedIn };
  return nodemailer.createTransport({
    ...account.smtp,
    requireTLS: !account.smtp.secure,
    auth,
    getSocket: smtpSocket(account.smtp, network, patience, opened),
    connectionTimeout: patience,
    greetingTimeout: patience,
    socketTimeout: patience,
    ...(network.ca ? { tls: { ca: [toText(network.ca)] } } : {}),
    ...log,
  });
}

function smtpSocket(
  { host, port, secure }: Endpoint,
  network: Network,
  patience: number,
  opened?: (socket: Socket) => void,
): SMTPTransportGetSocket {
  const ca = network.ca ? { ca: [toText(network.ca)] } : {};
  return (_options, callback) => {
    // Opened by host name, so the certificate is checked against the name on every runtime.
    const socket = secure ? tls({ host, port, servername: host, ...ca }) : tcp({ host, port });
    opened?.(socket);
    // It calls back once. Later errors are the connection's, which nodemailer hears itself.
    let answered = false;
    const answer = (error?: Error) => {
      if (answered) return;
      answered = true;
      clearTimeout(quiet);
      if (error) callback(error);
      else callback(null, { connection: socket, secured: secure });
    };
    // nodemailer times nothing until this calls back, so a host that never answers is timed here.
    const quiet = setTimeout(() => {
      socket.destroy();
      answer(Object.assign(new Error('It didn’t answer.'), { code: 'ETIMEDOUT' }));
    }, patience);
    socket.once(secure ? 'secureConnect' : 'connect', () => answer());
    socket.once('error', answer);
  };
}

/** What a connection signs in with: the password, or an access token asked for just now. */
async function credentialsOf(
  auth: ImapAccount['auth'],
): Promise<{ user: string; pass: string } | { user: string; accessToken: string }> {
  return 'pass' in auth ? auth : { user: auth.user, accessToken: await auth.accessToken() };
}

/** A connection to the account's IMAP host, which keeps what the host said when it refused. */
async function imapConnection(
  account: ImapAccount,
  network: Network,
  options: Pick<ImapFlowOptions, 'autoIdleDelay' | 'maxIdleTime' | 'socketTimeout'> = {},
): Promise<ImapFlow> {
  const { host, port, secure } = account.imap;
  const auth = await credentialsOf(account.auth);
  const quiet = () => {};
  const connection: ImapFlow = new ImapFlow({
    host,
    port,
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth,
    // imapflow logs some refusals instead of throwing them. What the server said is kept. It
    // builds an entry only for a level the logger has, and debug entries, which spell out each
    // response, cost a sync batch half its CPU again. So there is no debug or info here, though
    // imapflow's type asks for both.
    logger: {
      error: quiet,
      warn: (entry: { err?: { response?: unknown } }) => {
        const said = entry.err?.response;
        if (typeof said === 'string' && said) refusals.set(connection, said);
      },
    } as Partial<ImapLogger> as ImapLogger,
    ...options,
    ...(network.imapTransport ? { transport: network.imapTransport } : {}),
    ...(network.ca ? { tls: { ca: [toText(network.ca)] } } : {}),
  });
  // A dropped connection surfaces as a failed command, and the next command reconnects.
  connection.on('error', () => {});
  return connection;
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

type ImapLogger = Exclude<
  NonNullable<NonNullable<ConstructorParameters<typeof ImapFlow>[0]>['logger']>,
  false
>;

/** What each connection's server said when it last refused a command. */
const refusals = new WeakMap<ImapFlow, string>();

/**
 * Runs a command that imapflow reports refused by resolving `false`, and rejects with what the
 * server said instead, so a member sees why.
 */
async function unlessRefused<T>(
  connection: ImapFlow,
  what: string,
  command: () => Promise<T | false>,
): Promise<T> {
  refusals.delete(connection);
  const result = await command();
  if (result === false) {
    throw new Error(refusals.get(connection) ?? `The server would not ${what}.`);
  }
  return result;
}

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

/** Ascending UIDs as an IMAP sequence set, with runs collapsed, so a long list stays short. */
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
