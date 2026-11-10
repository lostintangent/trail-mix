import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { createSocketsTransport } from 'imapflow';
import PostalMime, { type Address as PostalAddress } from 'postal-mime';
import { messageOf } from '../../composer/index.ts';
import {
  messageIdOf,
  writeMime,
  type Account,
  type AccountId,
  type Body,
  type ConversationId,
  type Envelope,
  type Flags,
  type Folder,
  type FolderRef,
  type FolderRole,
  type Hint,
  type Message,
  type MessageRef,
  type MimeAttachment,
  type Outgoing,
  type View,
} from '../../mail/core/index.ts';
import {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
  imapProvider,
  PRESETS,
  type DemoKind,
  type MailProvider,
  type Moved,
  type SyncWindow,
} from '../../providers/index.ts';
import type { AccountSetup, DraftUpload, Mailroom as Contract, Page } from '../client/contract.ts';
import {
  accountBook,
  demoSettings,
  type AccountBook,
  type Connection,
  type DemoSettings,
} from './accounts.ts';
import { memberKey, open, seal } from './credentials.ts';
import { envelopeIndex, pageAfter, type EnvelopeIndex } from './envelope-index.ts';
import * as input from './input.ts';
import { upgrade, type Sql, type SqlValue } from './schema.ts';
import { outboxQueue, type OutboxQueue } from './outbox.ts';
import { foundOf, opened, sameRef, type Found } from './search.ts';
import { syncQueue, type SyncQueue } from './sync.ts';

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
  /** Fixes the demo accounts' creation time, an ISO 8601 instant, so their dates never move. */
  DEMO_MAILBOX_AT?: string;
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
  protected readonly queue: SyncQueue;
  protected readonly sending: OutboxQueue;
  /** When every account was last owed a check. A cold start checks at its first wake. */
  private checkedAt = 0;
  private key: Promise<CryptoKey> | undefined;
  /** The last full-text search. Only memory holds it, so a restart forgets it. */
  private found: Found | undefined;
  /** Drafts this Mailroom filed, whose attachments the next version may carry before sync sees it. */
  private readonly drafts = new Set<string>();
  private readonly demo: DemoSettings | undefined;

  constructor(ctx: DurableObjectState, env: MailroomEnv) {
    super(ctx, env);
    this.demo = demoSettings(env.DEMO_MAILBOX, env.DEMO_MAILBOX_AT);
    this.sql = durableSql(ctx.storage);
    const found = upgrade(this.sql);
    this.store = envelopeIndex(this.sql);
    this.book = accountBook(this.sql);
    this.queue = syncQueue({
      sql: this.sql,
      store: this.store,
      hint: (hint) => this.hint(hint),
      provider: (account) => this.provider(account),
      window: (account) => this.windowOf(account),
      settled: (account, error) => {
        if (error) report(error);
        this.setStatus(account, error ? 'error' : 'ready');
      },
    });
    this.sending = outboxQueue({
      sql: this.sql,
      provider: (account) => this.provider(account),
      hint: (hint) => this.hint(hint),
      sent: ({ draft }) => {
        this.queue.folder({ account: draft.account, path: draft.path });
        const sent = this.store.folders(draft.account).find((folder) => folder.role === 'sent');
        if (sent) this.queue.folder(folderRef(sent));
      },
      accepted: () => this.accepted(),
    });
    // Every wake is a cold start, and this is where one begins: a send found mid-submit was cut
    // short by whatever ended the last instance.
    this.sending.recover();
    if (found === 0 && this.demo) {
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

  async conversations(view: View, after?: string): Promise<Page> {
    const checked = input.viewOf(view);
    const cursor = input.cursorOf(after);
    if (checked.in === 'outbox') throw new TypeError('The Outbox is listed by outbox().');
    if (checked.in !== 'search') return this.store.page(checked, cursor);
    if (!checked.fullText) return this.store.search(checked.text, cursor);
    // A first page asks the servers again. Later pages read what that one found.
    if (cursor === undefined || this.found?.text !== checked.text) {
      this.found = await this.searchServers(checked.text);
    }
    return pageAfter(this.found.rows, cursor);
  }

  conversation(id: ConversationId): Promise<Message[]> {
    return Promise.resolve(opened(input.conversationOf(id), this.store, this.found?.outside ?? []));
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
    return Promise.resolve(this.sending.list().map((outgoing) => this.placed(outgoing)));
  }

  // Commands

  async addAccount(setup: AccountSetup): Promise<Account> {
    const checked = input.setupOf(setup);
    if (checked.provider === 'demo') {
      const account = this.addDemo();
      this.hint({ changed: 'accounts' });
      await this.owe(() => this.queue.check(account.id));
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
        ...(checked.fromName ? { fromName: checked.fromName } : {}),
        provider: 'imap',
        ...(checked.preset ? { preset: checked.preset } : {}),
      },
      connection,
      { sealed: await seal(await this.memberKey(), checked.password, id) },
    );
    this.hint({ changed: 'accounts' });
    await this.owe(() => this.queue.check(id));
    return account;
  }

  updateAccount(
    id: AccountId,
    change: Partial<Pick<Account, 'name' | 'fromName' | 'stamp' | 'signature'>>,
  ): Promise<void> {
    const { fromName, ...checked } = input.accountChangeOf(change);
    const updated = this.book.update(input.accountOf(id), ({ fromName: held, ...account }) => {
      const name = fromName ?? held;
      return { ...account, ...checked, ...(name ? { fromName: name } : {}) };
    });
    if (!updated) throw new Error('There is no such account.');
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
      this.sending.forget(account);
    });
    this.found = undefined;
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
    this.found = undefined;
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
      await this.owe(() => {
        for (const path of new Set(held.map((ref) => ref.path)))
          this.queue.folder({ account, path });
      });
    }
  }

  async move(refs: MessageRef[], to: FolderRef | FolderRole): Promise<Moved[]> {
    const destination = input.destinationOf(to);
    const moved: Moved[] = [];
    for (const [account, held] of this.byAccount(refs)) {
      const path =
        typeof destination === 'string'
          ? this.pathWithRole(account, destination)
          : destination.path;
      moved.push(...(await (await this.provider(account)).move(held, path)));
      await this.owe(() => {
        for (const from of new Set([...held.map((ref) => ref.path), path])) {
          this.queue.folder({ account, path: from });
        }
      });
    }
    return moved;
  }

  /**
   * Writes a draft as mail and files it in the account's Drafts, where it replaces the version
   * before it. An attachment that travelled before is read from the message that holds it.
   */
  async saveDraft(draft: DraftUpload, replaces?: MessageRef): Promise<MessageRef> {
    const checked = input.draftOf(draft);
    const older = replaces === undefined ? undefined : input.refOf(replaces);
    const account = this.book.get(checked.account)?.account;
    if (!account) throw new Error('There is no such account.');
    if (older && older.account !== account.id) {
      throw new TypeError('A draft replaces only a draft of the account it is from.');
    }
    if (older && this.sending.holds(older)) {
      throw new Error('That draft is on its way. Undo the send to change it.');
    }
    const parent = checked.inReplyTo && this.known(checked.inReplyTo);
    if (checked.inReplyTo && !parent) throw new Error('The message this replies to is gone.');
    const attachments: MimeAttachment[] = [];
    for (const attachment of checked.attachments) {
      if ('file' in attachment) {
        const { name, type, content } = attachment.file;
        const { contentId } = attachment;
        attachments.push({ name, type, content, ...(contentId ? { contentId } : {}) });
        continue;
      }
      const bytes = await this.bytes(attachment.in);
      const held = bytes && (await attachmentOf(bytes, Number(attachment.id)));
      if (!held) throw new Error('An attachment this draft carried over is gone.');
      attachments.push(held);
    }
    const message = messageOf(
      {
        from: { ...(account.fromName ? { name: account.fromName } : {}), email: account.address },
        to: checked.to,
        cc: checked.cc,
        bcc: checked.bcc,
        subject: checked.subject,
        markdown: checked.markdown,
        ...(parent ? { parent } : {}),
        attachments,
      },
      {
        date: new Date().toISOString(),
        messageId: `<${crypto.randomUUID()}@${account.address.split('@')[1]}>`,
        boundary: crypto.randomUUID(),
      },
    );
    const raw = new TextEncoder().encode(writeMime(message));
    const saved = await (await this.provider(account.id)).saveDraft(raw, older);
    this.drafts.add(refKeyOf(saved));
    if (older) {
      // Each save replaces the last, so the cache keeps only the newest draft's bytes.
      this.drafts.delete(refKeyOf(older));
      await this.env.BODIES.delete(this.bodyKey(older));
      this.sending.release(older);
    }
    await this.owe(() => this.queue.folder({ account: account.id, path: saved.path }));
    return saved;
  }

  /**
   * Schedules a draft to send when the undo window closes, or at a later time. The draft stays in
   * Drafts, as it is, until the host accepts it.
   */
  async send(draft: MessageRef, at?: string): Promise<Outgoing> {
    const ref = input.refOf(draft);
    const when = at === undefined ? undefined : input.instantOf(at);
    if (!this.book.get(ref.account)) throw new Error('There is no such account.');
    if (this.store.reads.role(ref) !== 'drafts') throw new Error('Only a draft can be sent.');
    const outgoing = this.sending.send(
      { draft: ref, ...(await this.addressing(ref)) },
      new Date().toISOString(),
      when,
    );
    await this.wakeBy(Date.parse(outgoing.sendAt));
    return this.placed(outgoing);
  }

  cancelSend(id: string): Promise<MessageRef> {
    return Promise.resolve(this.sending.cancel(input.sendOf(id)));
  }

  async retrySend(id: string): Promise<Outgoing> {
    const retried = this.sending.retry(input.sendOf(id), new Date().toISOString());
    await this.wakeBy(Date.parse(retried.sendAt));
    return this.placed(retried);
  }

  /** A send with the conversation its draft is in, as the index knows it now. */
  private placed(outgoing: Outgoing): Outgoing {
    const conversation = this.store.reads.message(outgoing.draft)?.conversation;
    return conversation === undefined ? outgoing : { ...outgoing, conversation };
  }

  async createFolder(folder: FolderRef): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    await (await this.provider(account)).createFolder(path);
    await this.owe(() => this.queue.check(account));
  }

  async renameFolder(folder: FolderRef, to: string): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    const renamed = input.folderOf({ account, path: to }).path;
    await (await this.provider(account)).renameFolder(path, renamed);
    await this.owe(() => this.queue.check(account));
  }

  async deleteFolder(folder: FolderRef): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    await (await this.provider(account)).deleteFolder(path);
    await this.owe(() => this.queue.check(account));
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
    const attachment = await attachmentOf(bytes, Number(attachmentId));
    if (!attachment) return null;
    return {
      // The Workers runtime types a Blob's stream loosely, as ReadableStream<any>, so it's named here.
      body: new Blob([attachment.content]).stream() as ReadableStream<Uint8Array>,
      type: attachment.type,
      name: attachment.name,
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
    this.background(this.owe(() => this.checkAll()));
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
   * eviction drops what it held in memory. It is also the only place sync runs: everything else
   * owes sync and sets the alarm for now, so every wake lands a bounded share.
   */
  override async alarm(): Promise<void> {
    await this.wake();
  }

  /**
   * One wake. While a device is open, the alarm fires every minute, which keeps the Mailroom in
   * memory and the Inbox watchers alive. Every account is owed a check every few minutes either
   * way. A wake lands what is owed within its budget, and if more remains, the next wake follows at
   * once and picks up from the stored cursors. Returns how many steps it landed.
   */
  protected async wake(): Promise<number> {
    const accounts = this.book.all();
    if (accounts.length === 0) return 0;
    const open = this.devices() > 0;
    // If this wake ends early, as an eviction would end it, the next one is already set.
    const poll = Date.now() + (open ? WATCHING_MS : CHECKING_MS);
    await this.ctx.storage.setAlarm(Math.min(poll, this.sending.nextWake() ?? poll));
    // A send that is due goes before sync, which can wait.
    await this.sending.run(() => new Date().toISOString());
    if (Date.now() - this.checkedAt >= CHECKING_MS) this.checkAll();
    await this.watchAll(open);
    const landed = await this.queue.run();
    // A new account's Inbox is known only once its folders are.
    await this.watchAll(this.devices() > 0);
    const sendAt = this.sending.nextWake() ?? poll;
    if (this.queue.owing() || sendAt <= Date.now()) await this.ctx.storage.setAlarm(Date.now());
    else await this.ctx.storage.setAlarm(Math.min(poll, sendAt));
    return landed;
  }

  private checkAll() {
    this.checkedAt = Date.now();
    for (const { id } of this.book.all()) this.queue.check(id);
  }

  /** Has the alarm come by `at`, unless it is already set to come sooner. */
  private async wakeBy(at: number) {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  /** Runs once the host has accepted a message and before the Outbox records it. */
  protected accepted(): void {}

  /** Owes sync, and has the next wake land it at once. */
  private async owe(owing: () => void) {
    owing();
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async watchAll(open: boolean) {
    for (const { id } of this.book.all()) {
      if (open) await this.watch(id).catch(report);
      else this.unwatch(id);
    }
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
      provider.watch(folder.path, () => this.background(this.owe(() => this.queue.folder(folder)))),
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

  /** Forgets what an account owes, so a step of it under way lands nothing, and closes its provider. */
  private async disconnect(account: AccountId) {
    this.queue.forget(account);
    this.unwatch(account);
    const provider = this.providers.get(account);
    this.providers.delete(account);
    const opened = await provider?.catch(() => undefined);
    await opened?.close().catch(report);
  }

  /** Asks every folder of every account's server, and keeps what they found apart from the index. */
  private async searchServers(text: string): Promise<Found> {
    const hits = await Promise.all(
      this.book.all().map(async ({ id }) => {
        const found: Envelope[] = [];
        try {
          const provider = await this.provider(id);
          for (const { path } of this.store.folders(id)) {
            // A folder the server won't search leaves out its hits, and the rest still count.
            found.push(
              ...(await provider.search(path, text).catch((error: unknown) => {
                report(error);
                return [];
              })),
            );
          }
        } catch (error) {
          report(error);
        }
        return found;
      }),
    );
    return foundOf(text, hits.flat(), this.store);
  }

  /** Adds the first demo account not yet here, Personal and then Work. */
  private addDemo(): Account {
    if (!this.demo) throw new Error('This deployment has no demo mailbox.');
    const { inbox: size, createdAt = new Date().toISOString() } = this.demo;
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
      {
        id: crypto.randomUUID(),
        name,
        address: me.email,
        ...(me.name ? { fromName: me.name } : {}),
        provider: 'demo',
      },
      { provider: 'demo', kind },
      { demo: demoMailbox(kind, inbox, createdAt) },
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
    const key = this.bodyKey(ref);
    const cached = await this.env.BODIES.get(key);
    if (cached) return new Uint8Array(await cached.arrayBuffer());
    if (!this.known(ref) && !this.drafts.has(refKeyOf(ref))) return null;
    const stream = await (await this.provider(ref.account)).body(ref);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    await this.env.BODIES.put(key, bytes);
    return bytes;
  }

  private bodyKey(ref: MessageRef) {
    return `${this.member}/${ref.account}/${encodeURIComponent(ref.path)}/${ref.uidValidity}/${ref.uid}`;
  }

  /**
   * Who a draft is to and what it's about, as its send keeps them, and its Message-ID, which the
   * send needs to find its copy in Sent. From the index, or from the draft itself before sync has it.
   */
  private async addressing(
    draft: MessageRef,
  ): Promise<Pick<Outgoing, 'messageId' | 'to' | 'subject'>> {
    const held = this.store.reads.message(draft);
    const found = held ?? (await this.parsedDraft(draft));
    if (!found.messageId)
      throw new Error('That draft has no Message-ID, so it can’t be sent safely.');
    return { messageId: found.messageId, to: [...found.to, ...found.cc], subject: found.subject };
  }

  private async parsedDraft(draft: MessageRef) {
    const bytes = await this.bytes(draft);
    if (!bytes) throw new Error('That draft is gone.');
    const parsed = await PostalMime.parse(bytes);
    const addresses = (list: PostalAddress[] | undefined) =>
      (list ?? [])
        .flatMap((entry) => entry.group ?? [entry])
        .flatMap(({ name, address }) =>
          address ? [{ ...(name ? { name } : {}), email: address }] : [],
        );
    return {
      messageId: messageIdOf(parsed.messageId),
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      subject: parsed.subject ?? '',
    };
  }

  /** A message the index holds, or the last full-text search found. */
  private known(ref: MessageRef) {
    return this.store.reads.message(ref) ?? this.found?.outside.find((hit) => sameRef(hit, ref));
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

/** The Mailroom's storage, as `schema.ts` speaks to it, on a Durable Object's SQLite. */
function durableSql(storage: DurableObjectStorage): Sql {
  const bind = (params: SqlValue[]) =>
    params.map((param) => (param instanceof Uint8Array ? param.slice().buffer : param));
  return {
    all: <Row>(query: string, ...params: SqlValue[]) =>
      storage.sql.exec(query, ...bind(params)).toArray() as Row[],
    each: <Row>(query: string, ...params: SqlValue[]) =>
      storage.sql.exec(query, ...bind(params)) as Iterable<Row>,
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

const refKeyOf = ({ account, path, uidValidity, uid }: MessageRef) =>
  JSON.stringify([account, path, uidValidity, uid]);

/** One attachment of a raw message, by its place among them, as `Body.attachments` numbers them. */
async function attachmentOf(bytes: Uint8Array, index: number): Promise<MimeAttachment | undefined> {
  const attachment = (await PostalMime.parse(bytes)).attachments[index];
  if (!attachment) return undefined;
  const content =
    typeof attachment.content === 'string'
      ? new TextEncoder().encode(attachment.content)
      : new Uint8Array(attachment.content);
  return {
    name: attachment.filename ?? `Attachment ${index + 1}`,
    type: attachment.mimeType,
    content,
    ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '') } : {}),
  };
}
