import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { createSocketsTransport } from 'imapflow';
import PostalMime from 'postal-mime';
import type {
  Account,
  AccountId,
  Body,
  ConversationId,
  Flags,
  Folder,
  FolderRef,
  FolderRole,
  Hint,
  Message,
  MessageRef,
  Outgoing,
  View,
} from '../../mail/core/index.ts';
import {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
  imapProvider,
  PRESETS,
  type DemoKind,
  type MailProvider,
  type SyncWindow,
} from '../../providers/index.ts';
import type { AccountSetup, DraftInput, Mailroom as Contract, Page } from '../client/index.ts';
import { accountBook, type AccountBook, type Connection } from './accounts.ts';
import { memberKey, open, seal } from './credentials.ts';
import { envelopeIndex, type EnvelopeIndex } from './envelope-index.ts';
import * as input from './input.ts';
import { upgrade, type Sql, type SqlValue } from './schema.ts';
import { syncFolder, syncFolders, type Syncing } from './sync.ts';

export type MailroomEnv = {
  /** The body cache: raw messages, by member, account and ref. */
  BODIES: R2Bucket;
  /** The Worker secret each member's credentials key is derived from. */
  CREDENTIALS_KEY?: string;
  /**
   * Enables the demo mailbox, and gives every new Mailroom its two accounts: Personal with this
   * many messages in its Inbox, and Work with a tenth as many.
   */
  DEMO_MAILBOX?: string;
};

/** How far back mail is indexed. Older mail stays on the server. */
const WINDOW_DAYS = 365;
/** While a device is open, the alarm keeps the Mailroom awake and its watchers alive. */
const WATCHING_MS = 60_000;
/** Every account is checked this often, whether or not a device is open. */
const CHECKING_MS = 5 * 60_000;

/**
 * The Mailroom: one Durable Object per member, and the only writer of anything Trail Mix stores
 * for them. It holds their accounts and sealed credentials, folds what each provider reports into
 * the envelope index, keeps the bodies they open, and hints every open device to refetch what
 * changed.
 *
 * Every wake is a cold start. Nothing held in memory is needed again: providers reconnect, sync
 * resumes from the cursors in storage, and watching starts again on the next alarm.
 */
export class Mailroom extends DurableObject<MailroomEnv> implements Contract {
  protected readonly sql: Sql;
  protected readonly store: EnvelopeIndex;
  private readonly book: AccountBook;
  private readonly providers = new Map<AccountId, Promise<MailProvider>>();
  private readonly watchers = new Map<AccountId, () => void>();
  private readonly runs = new Map<string, Run>();
  private checkedAt = 0;
  private key: Promise<CryptoKey> | undefined;

  constructor(ctx: DurableObjectState, env: MailroomEnv) {
    super(ctx, env);
    this.sql = durableSql(ctx.storage);
    const found = upgrade(this.sql);
    this.store = envelopeIndex(this.sql);
    this.book = accountBook(this.sql);
    if (found === 0 && env.DEMO_MAILBOX) {
      this.addDemo();
      this.addDemo();
      // The alarm fills the index, whether or not a device opens.
      void ctx.storage.setAlarm(Date.now());
    }
  }

  // Queries

  accounts(): Promise<Account[]> {
    return Promise.resolve(this.book.all());
  }

  folders(): Promise<Folder[]> {
    return Promise.resolve(this.store.folders());
  }

  conversations(view: View, after?: string): Promise<Page> {
    const checked = input.viewOf(view);
    const cursor = input.cursorOf(after);
    // Search and the Outbox arrive with their own steps, and are empty until then.
    if (checked.in === 'search' || checked.in === 'outbox') return Promise.resolve({ items: [] });
    return Promise.resolve(this.store.page(checked, cursor));
  }

  conversation(id: ConversationId): Promise<Message[]> {
    return Promise.resolve(this.store.conversation(input.conversationOf(id)));
  }

  async body(ref: MessageRef): Promise<Body> {
    const bytes = await this.bytes(input.refOf(ref));
    if (!bytes) throw new Error('That message is no longer in this mailbox.');
    const parsed = await PostalMime.parse(bytes);
    return {
      ...(parsed.html === undefined ? {} : { html: parsed.html }),
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
      attachments: parsed.attachments.map((attachment, index) => ({
        id: String(index),
        name: attachment.filename ?? `Attachment ${index + 1}`,
        type: attachment.mimeType,
        size: sizeOf(attachment.content),
        ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '') } : {}),
      })),
      headers: parsed.headers.map((header) => [header.originalKey, header.value]),
    };
  }

  outbox(): Promise<Outgoing[]> {
    return Promise.resolve([]);
  }

  // Commands

  async addAccount(setup: AccountSetup): Promise<Account> {
    const checked = input.setupOf(setup);
    if (checked.provider === 'demo') {
      const account = this.addDemo();
      this.hint({ changed: 'accounts' });
      this.background(this.check(true));
      return account;
    }
    if (!('password' in checked)) throw new Error('Outlook sign-in arrives with its own step.');
    const address = checked.address.toLowerCase();
    if (this.book.all().some((held) => held.address.toLowerCase() === address)) {
      throw new Error(`${checked.address} is already connected.`);
    }
    const preset = checked.preset && PRESETS[checked.preset];
    const connection: Connection = {
      provider: 'imap',
      imap: preset?.imap ?? checked.imap!,
      smtp: preset?.smtp ?? checked.smtp!,
      user: checked.address,
      filesSent: preset?.filesSent ?? false,
    };

    // Nothing is kept until the host accepts the password.
    const id = crypto.randomUUID();
    const trial = imapOver(id, connection, checked.password);
    try {
      await trial.folders();
    } finally {
      await trial.close();
    }

    const account = this.book.add(
      {
        id,
        name: checked.name,
        address: checked.address,
        provider: 'imap',
        ...(checked.preset ? { preset: checked.preset } : {}),
      },
      connection,
      { sealed: await seal(await this.memberKey(), checked.password, id) },
    );
    this.hint({ changed: 'accounts' });
    this.background(this.check(true));
    return account;
  }

  updateAccount(
    id: AccountId,
    change: Partial<Pick<Account, 'name' | 'stamp' | 'signature'>>,
  ): Promise<void> {
    const checked = input.accountChangeOf(change);
    if (!this.book.update(input.accountOf(id), (account) => ({ ...account, ...checked }))) {
      throw new Error('There is no such account.');
    }
    this.hint({ changed: 'accounts' });
    return Promise.resolve();
  }

  async removeAccount(id: AccountId): Promise<void> {
    const account = input.accountOf(id);
    if (!this.book.get(account)) return;
    await this.disconnect(account);
    const folders = this.store.folders(account);
    this.sql.transaction(() => {
      this.book.remove(account);
      this.store.forget(account);
    });
    this.hint({ changed: 'accounts' });
    this.hint({ changed: 'folders', account });
    for (const folder of folders)
      this.hint({ changed: 'conversations', folder: folderRef(folder) });
    await this.forgetBodies(`${this.member}/${account}/`);
  }

  allowImages(account: AccountId, sender: string): Promise<void> {
    const address = input.senderOf(sender);
    const known = this.book.update(input.accountOf(account), (held) =>
      held.allowImagesFrom.includes(address)
        ? held
        : { ...held, allowImagesFrom: [...held.allowImagesFrom, address] },
    );
    if (!known) throw new Error('There is no such account.');
    this.hint({ changed: 'accounts' });
    return Promise.resolve();
  }

  async eraseEverything(): Promise<void> {
    const accounts = this.book.all();
    for (const { id } of accounts) await this.disconnect(id);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    upgrade(this.sql);
    this.hint({ changed: 'accounts' });
    for (const { id } of accounts) this.hint({ changed: 'folders', account: id });
    await this.forgetBodies(`${this.member}/`);
  }

  async setFlags(refs: MessageRef[], change: Partial<Flags>): Promise<void> {
    const checked = input.flagsOf(change);
    for (const [account, held] of this.byAccount(refs)) {
      await (await this.provider(account)).setFlags(held, checked);
      for (const path of new Set(held.map((ref) => ref.path))) {
        this.background(this.syncFolder({ account, path }));
      }
    }
  }

  async move(refs: MessageRef[], to: FolderRef | FolderRole): Promise<void> {
    const destination = input.destinationOf(to);
    for (const [account, held] of this.byAccount(refs)) {
      const path =
        typeof destination === 'string'
          ? this.pathWithRole(account, destination)
          : destination.path;
      await (await this.provider(account)).move(held, path);
      for (const from of new Set([...held.map((ref) => ref.path), path])) {
        this.background(this.syncFolder({ account, path: from }));
      }
    }
  }

  saveDraft(_draft: DraftInput, _replaces?: MessageRef): Promise<MessageRef> {
    return Promise.reject(new Error('Drafts arrive with the composer.'));
  }

  send(_draft: MessageRef, _at?: string): Promise<Outgoing> {
    return Promise.reject(new Error('Sending arrives with the Outbox.'));
  }

  cancelSend(_id: string): Promise<MessageRef> {
    return Promise.reject(new Error('Sending arrives with the Outbox.'));
  }

  async createFolder(folder: FolderRef): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    await (await this.provider(account)).createFolder(path);
    this.background(this.syncAccount(account));
  }

  async renameFolder(folder: FolderRef, to: string): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    const renamed = input.folderOf({ account, path: to }).path;
    await (await this.provider(account)).renameFolder(path, renamed);
    this.background(this.syncAccount(account));
  }

  async deleteFolder(folder: FolderRef): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    await (await this.provider(account)).deleteFolder(path);
    this.background(this.syncAccount(account));
  }

  // A message's bytes, for the Worker's routes. Null means the message or part is gone.

  async source(ref: MessageRef): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.bytes(input.refOf(ref));
    return bytes && new Blob([bytes]).stream();
  }

  async part(
    ref: MessageRef,
    attachmentId: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; type: string; name: string } | null> {
    const bytes = await this.bytes(input.refOf(ref));
    if (!bytes || !/^\d{1,4}$/.test(String(attachmentId))) return null;
    const index = Number(attachmentId);
    const attachment = (await PostalMime.parse(bytes)).attachments[index];
    if (!attachment) return null;
    const content =
      typeof attachment.content === 'string'
        ? new TextEncoder().encode(attachment.content)
        : new Uint8Array(attachment.content);
    return {
      body: new Blob([content]).stream(),
      type: attachment.mimeType,
      name: attachment.filename ?? `Attachment ${index + 1}`,
    };
  }

  // The hint socket, and staying current

  override fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Promise.resolve(new Response('Hints arrive on a WebSocket.', { status: 426 }));
    }
    const { 0: device, 1: socket } = new WebSocketPair();
    this.ctx.acceptWebSocket(socket);
    // A device just opened: catch up now, and watch while any device stays open.
    this.background(this.check(true));
    return Promise.resolve(new Response(null, { status: 101, webSocket: device }));
  }

  override webSocketMessage(): void {
    // Devices only listen.
  }

  override webSocketClose(socket: WebSocket): void {
    if (this.devices(socket) === 0) for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  override webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }

  /**
   * The alarm is the Mailroom's heartbeat, and the first thing that runs after a deploy or an
   * eviction drops what it held in memory.
   */
  override async alarm(): Promise<void> {
    await this.check(false);
  }

  /**
   * While a device is open, the alarm fires every minute, which keeps the Mailroom in memory and
   * reopens the Inbox watchers. Every account is checked every few minutes either way, and at once
   * when asked, as when a device opens.
   */
  private async check(now: boolean) {
    const accounts = this.book.all();
    if (accounts.length === 0) return;
    const open = this.devices() > 0;
    await this.ctx.storage.setAlarm(Date.now() + (open ? WATCHING_MS : CHECKING_MS));
    for (const { id } of accounts) {
      if (open) await this.watch(id).catch(report);
      else this.unwatch(id);
    }
    if (!now && open && Date.now() - this.checkedAt < CHECKING_MS) return;
    this.checkedAt = Date.now();
    await Promise.all(accounts.map(({ id }) => this.syncAccount(id).catch(report)));
  }

  private async watch(account: AccountId) {
    if (this.watchers.has(account)) return;
    const inbox = this.store.folders(account).find((folder) => folder.role === 'inbox');
    if (!inbox) return;
    const provider = await this.provider(account);
    if (this.watchers.has(account)) return;
    const folder = folderRef(inbox);
    this.watchers.set(
      account,
      provider.watch(folder.path, () => this.background(this.syncFolder(folder))),
    );
  }

  private unwatch(account: AccountId) {
    this.watchers.get(account)?.();
    this.watchers.delete(account);
  }

  /** The devices open now, apart from one that is closing. */
  private devices(closing?: WebSocket) {
    return this.ctx.getWebSockets().filter((socket) => socket !== closing).length;
  }

  /** Tells every open device what changed. A device that misses one refetches on reconnect. */
  private hint(hint: Hint) {
    const message = JSON.stringify(hint);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // Closing as this sends.
      }
    }
  }

  // Sync: one run at a time for each account and folder, and one more if asked again meanwhile

  private syncAccount(account: AccountId) {
    return this.once(account, 'account', async () => {
      try {
        const provider = await this.provider(account);
        // The folders were just counted, so the folder syncs needn't count them again.
        for (const folder of await syncFolders(this.syncing, account, provider)) {
          await this.syncFolder(folderRef(folder), false);
        }
        this.setStatus(account, 'ready');
      } catch (error) {
        this.setStatus(account, 'error');
        throw error;
      }
    });
  }

  /** Syncs a folder, then counts the account's folders again if the server reported a change. */
  private syncFolder(folder: FolderRef, recount = true) {
    return this.once(folder.account, `folder ${folder.path}`, async () => {
      if (!this.book.get(folder.account)) return;
      const provider = await this.provider(folder.account);
      const window = this.windowOf(folder.account);
      const changed = await syncFolder(this.syncing, folder, provider, window);
      if (changed && recount) await syncFolders(this.syncing, folder.account, provider);
    });
  }

  /**
   * Runs `run` unless the same sync of the same account is under way. Then that one goes once more
   * when it finishes, as the latest caller asked, and both callers wait for it.
   */
  private once(account: AccountId, what: string, run: () => Promise<void>): Promise<void> {
    const key = JSON.stringify([account, what]);
    const running = this.runs.get(key);
    if (running) {
      running.next = run;
      return running.done;
    }
    const entry: Run = { account, done: Promise.resolve(), next: run };
    entry.done = (async () => {
      try {
        for (let current = entry.next; current; current = entry.next) {
          entry.next = undefined;
          await current();
        }
      } finally {
        this.runs.delete(key);
      }
    })();
    this.runs.set(key, entry);
    return entry.done;
  }

  private get syncing(): Syncing {
    return { sql: this.sql, store: this.store, hint: (hint) => this.hint(hint) };
  }

  private setStatus(account: AccountId, status: Account['status']) {
    const before = this.book.get(account)?.account.status;
    if (before === undefined || before === status) return;
    this.book.update(account, (held) => ({ ...held, status }));
    this.hint({ changed: 'accounts' });
  }

  // Providers, credentials and the body cache

  private provider(account: AccountId): Promise<MailProvider> {
    let provider = this.providers.get(account);
    if (!provider) {
      provider = (async () => {
        const connection = this.book.get(account)?.connection;
        if (connection?.provider === 'demo') {
          const mailbox = this.book.demo(account);
          if (!mailbox) throw new Error('There is no such account.');
          return demoServer(account, mailbox, (next) => this.book.saveDemo(account, next)).provider;
        }
        const sealed = this.book.sealed(account);
        if (!connection || !sealed) throw new Error('There is no such account.');
        const password = await open(await this.memberKey(), sealed, account);
        return imapOver(account, connection, password);
      })();
      this.providers.set(account, provider);
      provider.catch(() => this.providers.delete(account));
    }
    return provider;
  }

  /**
   * Closes an account's provider, which ends any sync under way at its next call, and waits for
   * those syncs to stop, so no late batch lands after the account is gone.
   */
  private async disconnect(account: AccountId) {
    this.unwatch(account);
    const provider = this.providers.get(account);
    this.providers.delete(account);
    const opened = await provider?.catch(() => undefined);
    await opened?.close().catch(report);
    const syncs = [...this.runs.values()].filter((run) => run.account === account);
    await Promise.allSettled(syncs.map((run) => run.done));
  }

  /** Adds the first demo account not yet here, Personal and then Work. */
  private addDemo(): Account {
    const size = Number(this.env.DEMO_MAILBOX);
    if (!Number.isInteger(size) || size < 1)
      throw new Error('This deployment has no demo mailbox.');
    const here = new Set(
      this.book
        .connections()
        .flatMap(({ connection }) => (connection.provider === 'demo' ? [connection.kind] : [])),
    );
    const kind = (Object.keys(DEMO_ACCOUNTS) as DemoKind[]).find((held) => !here.has(held));
    if (!kind) throw new Error('Both demo accounts are already here.');
    const { name, me } = DEMO_ACCOUNTS[kind];
    const inbox = kind === 'personal' ? size : Math.ceil(size / 10);
    return this.book.add(
      { id: crypto.randomUUID(), name, address: me.email, provider: 'demo' },
      { provider: 'demo', kind },
      { demo: demoMailbox(kind, inbox, new Date().toISOString()) },
    );
  }

  /** What the index holds of an account: its last year, or a demo mailbox's year before it was made. */
  private windowOf(account: AccountId): SyncWindow {
    const until = this.book.demo(account)?.createdAt ?? new Date().toISOString();
    return { since: new Date(Date.parse(until) - WINDOW_DAYS * 86_400_000).toISOString() };
  }

  private memberKey(): Promise<CryptoKey> {
    const secret = this.env.CREDENTIALS_KEY;
    if (!secret) return Promise.reject(new Error('The operator hasn’t set CREDENTIALS_KEY.'));
    this.key ??= memberKey(secret, this.member);
    return this.key;
  }

  protected get member() {
    return this.ctx.id.toString();
  }

  /** A message's raw bytes: from the cache, or from the server once and kept from then on. */
  private async bytes(ref: MessageRef): Promise<Uint8Array<ArrayBuffer> | null> {
    const key = `${this.member}/${ref.account}/${encodeURIComponent(ref.path)}/${ref.uidValidity}/${ref.uid}`;
    const cached = await this.env.BODIES.get(key);
    if (cached) return new Uint8Array(await cached.arrayBuffer());
    if (!this.store.reads.message(ref)) return null;
    const stream = await (await this.provider(ref.account)).body(ref);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    await this.env.BODIES.put(key, bytes);
    return bytes;
  }

  protected async forgetBodies(prefix: string) {
    for (let cursor: string | undefined; ;) {
      const listed = await this.env.BODIES.list({ prefix, ...(cursor ? { cursor } : {}) });
      if (listed.objects.length) await this.env.BODIES.delete(listed.objects.map((o) => o.key));
      if (!listed.truncated) return;
      cursor = listed.cursor;
    }
  }

  // The member's own accounts and folders

  private byAccount(refs: MessageRef[]) {
    const groups = new Map<AccountId, MessageRef[]>();
    for (const ref of input.refsOf(refs)) {
      if (!this.book.get(ref.account)) throw new Error('There is no such account.');
      groups.set(ref.account, [...(groups.get(ref.account) ?? []), ref]);
    }
    return groups;
  }

  private ownFolder(folder: FolderRef): FolderRef {
    const checked = input.folderOf(folder);
    if (!this.book.get(checked.account)) throw new Error('There is no such account.');
    return checked;
  }

  private pathWithRole(account: AccountId, role: FolderRole) {
    const folder = this.store.folders(account).find((held) => held.role === role);
    if (!folder) throw new Error(`That account has no ${role} folder.`);
    return folder.path;
  }

  /** Work the caller doesn't wait for. Its failure is logged, and the next check tries again. */
  private background(work: Promise<unknown>) {
    this.ctx.waitUntil(work.catch(report));
  }
}

/** The IMAP provider for an account, over workerd's sockets. */
function imapOver(
  account: AccountId,
  connection: Extract<Connection, { provider: 'imap' }>,
  password: string,
): MailProvider {
  return imapProvider(
    {
      account,
      imap: connection.imap,
      smtp: connection.smtp,
      auth: { user: connection.user, pass: password },
      filesSent: connection.filesSent,
    },
    {
      // workerd's STARTTLS works only on its own sockets. Its types want `allowHalfOpen` given.
      imapTransport: createSocketsTransport((address, options) =>
        connect(address, options && { ...options, allowHalfOpen: options.allowHalfOpen ?? false }),
      ),
    },
  );
}

/** A sync under way, and the one to run after it, if asked for meanwhile. */
type Run = { account: AccountId; done: Promise<void>; next: (() => Promise<void>) | undefined };

/** The Mailroom's storage, as `schema.ts` speaks to it, on a Durable Object's SQLite. */
function durableSql(storage: DurableObjectStorage): Sql {
  const bind = (params: SqlValue[]) =>
    params.map((param) => (param instanceof Uint8Array ? param.slice().buffer : param));
  return {
    all: <Row>(query: string, ...params: SqlValue[]) =>
      storage.sql.exec(query, ...bind(params)).toArray() as Row[],
    run: (query, ...params) => void storage.sql.exec(query, ...bind(params)).toArray(),
    transaction: (work) => storage.transactionSync(work),
  };
}

const folderRef = ({ account, path }: FolderRef): FolderRef => ({ account, path });

const sizeOf = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength;

function report(error: unknown) {
  console.error('Mailroom:', error instanceof Error ? error.message : error);
}
