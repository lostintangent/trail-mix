import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import {
  refKey,
  type Account,
  type AccountId,
  type Address,
  type Body,
  type BundleId,
  type ConversationId,
  type Flags,
  type Folder,
  type FolderRef,
  type FolderRole,
  type Hint,
  type Message,
  type MessageRef,
  type Moved,
  type Outgoing,
  type SyncEvent,
  type View,
} from '../../mail/core/index.ts';
import {
  newsIn,
  noticesOf,
  pushOf,
  subscriptionOf,
  type Subscription,
} from '../../notifications/core/index.ts';
import { deliver, pushKeyOf, type PushKey } from '../../notifications/server/index.ts';
import {
  imap,
  namesThisMachine,
  type ImapPart,
  type MailProvider,
  type Preset,
  type PresetName,
} from '../../providers/index.ts';
import {
  COMMANDS,
  QUERIES,
  type AccountSetup,
  type Answered,
  type BundlePage,
  type BundleScope,
  type Call,
  type CommandName,
  type DraftUpload,
  type Mailroom as Contract,
  type Page,
  type PageAt,
  type QueryName,
  type SignIn,
  type SignInPreset,
  type SignInSetup,
  type ThisDevice,
  type Unsubscribed,
} from '../client/contract.ts';
import {
  erasesAt,
  idlenessOf,
  isWorthNoting,
  NOTIFYING_CHECKING_MS,
  scheduleOf,
  windDownOf,
  type WindDown,
} from '../core/idle.ts';
import {
  avatarCandidates,
  namedMessages,
  namedRows,
  verifiedSenders,
  type Picture,
} from '../core/avatars.ts';
import {
  accountBook,
  connectedAccounts,
  demoSettings,
  type AccountBook,
  type ConnectedAccounts,
  type DemoSettings,
} from './accounts.ts';
import { bodyCache, type BodyBatches, type BodyCache } from './bodies.ts';
import { connections, type Connections, type ImapCode } from './connections.ts';
import { credentialsOf } from './credentials.ts';
import { savingDrafts, type SavingDrafts } from './drafts.ts';
import { folderCommands, type FolderCommands } from './folders.ts';
import { notifying, type Notifying } from './notifying.ts';
import { envelopeIndex, type EnvelopeIndex } from './envelope-index.ts';
import * as input from './input.ts';
import { messageCommands, type MessageCommands } from './messages.ts';
import {
  avatarCache,
  avatarNetwork,
  demoSources,
  internetSources,
  INTERNET,
  keyed,
  standInInternet,
  type AvatarCache,
  type DomainFound,
} from './avatars.ts';
import { upgrade, type Sql, type SqlValue } from './schema.ts';
import {
  outboxCommands,
  outboxQueue,
  type LastUpload,
  type OutboxCommands,
  type OutboxQueue,
} from './outbox.ts';
import { fullTextSearch, type FullTextSearch } from './search.ts';
import { signingIn, type SigningIn } from './sign-ins.ts';
import { report } from './report.ts';
import { syncQueue, WAKE, type SyncQueue } from './sync.ts';
import { oneClick, type OneClick } from './unsubscribe.ts';

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
  /**
   * `true` has the demo's mail server file its own copy of what it accepts in Sent, a moment late,
   * as Zoho's does, so the Outbox waits for it.
   */
  DEMO_HOST_FILES_SENT?: string;
  /**
   * The deployment's Web Push key, a P-256 private key in PKCS #8 PEM. With `OPERATOR_EMAIL`, whom
   * push services contact about its pushes, it turns notifications on.
   */
  PUSH_KEY?: string;
  OPERATOR_EMAIL?: string;
  /** The app the operator registered with Microsoft, which Outlook accounts sign in through. */
  MICROSOFT_CLIENT_ID?: string;
  /** Whole days unopened before a Mailroom rests, and before it erases itself: 30 and 90 unset. */
  REST_AFTER_DAYS?: string;
  ERASE_AFTER_DAYS?: string;
  /**
   * Set only on the public demo, where the Worker signs visitors in with it. Its presence tells a
   * visitor's Mailroom, which holds only the demo mailbox, to check mail only while they have it
   * open, since nothing reaches the demo mailbox from outside, and to keep both demo accounts, since
   * filling one again writes thousands of rows.
   */
  VISITOR_KEY?: string;
  /**
   * A test's stand-in for Outlook, as JSON: Microsoft's sign-in and the hosts. Honored only when
   * every address in it names this machine.
   */
  OUTLOOK_STAND_IN?: string;
  /**
   * A test's names for the servers on this machine that sign Authentication-Results, as JSON from
   * host to names. Honored for hosts on this machine alone.
   */
  AUTH_SERVERS_STAND_IN?: string;
  /**
   * A test's stand-in for where avatars are looked up, as one origin: DNS over HTTPS at
   * `/dns-query`, answering as Cloudflare's does, Gravatar at `/gravatar/` and each domain's site
   * at `/sites/<domain>/`. Honored only when it names this machine.
   */
  AVATARS_STAND_IN?: string;
  /**
   * A test's stand-in for the senders' servers a one-click unsubscribe posts to, as one origin.
   * Honored only when it names this machine.
   */
  UNSUBSCRIBE_STAND_IN?: string;
};

/** Why a visitor's Mailroom keeps what it holds. */
const VISITORS_KEEP =
  'The demo keeps its two accounts, and erases itself a day after your last visit.';
/** How many refs of messages the member moved into an Inbox are held, oldest dropped first. */
const MOVED_IN_HELD = 1_000;
/** The most domains and senders one wake looks up pictures for. */
const AVATAR_LOOKUPS = { domains: 6, senders: 16 };
/** Where the id that names what an installed app keeps is stored. */
const CACHE_KEY = 'cache';
/** The most conversations one wake makes rows of again, as an upgrade asks. */
const RESUMMARIZED = 1_000;
/** The most messages one wake notes the people of, as an upgrade or a change of who counts asks. */
const PEOPLE_FILLED = 2_000;

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
  private readonly avatars: AvatarCache;
  private readonly connections: Connections;
  private readonly signingIn: SigningIn;
  private readonly connected: ConnectedAccounts;
  private readonly fullText: FullTextSearch;
  private readonly bodies: BodyCache;
  private readonly oneClick: OneClick;
  private readonly watchers = new Map<AccountId, () => void>();
  protected readonly queue: SyncQueue;
  protected readonly sending: OutboxQueue;
  private readonly drafts: SavingDrafts;
  protected readonly outboxCommands: OutboxCommands;
  private readonly folderCommands: FolderCommands;
  private readonly messageCommands: MessageCommands;
  /** When every account was last owed a check. A cold start checks at its first wake. */
  private checkedAt = 0;
  /** When a signed-in device last asked for something, as storage holds it. */
  protected openedAt: number;
  /** How long unopened before it rests, and before it erases itself. */
  private readonly windDown: WindDown;
  /** Whether this instance has had anything to do yet, so the first call can say it started it. */
  private isRunning = false;
  private readonly notifying: Notifying;
  /** Messages the member moved into an Inbox, by ref, whose arrival there is no news. */
  private readonly movedIn = new Set<string>();
  /** The news this wake's sync folded, told once the wake's sync is done. */
  private news: Message[] = [];
  private pushKey: Promise<PushKey | undefined> | undefined;
  private readonly demo: DemoSettings | undefined;
  /**
   * Whether this is a visitor's Mailroom on the public demo, which checks mail only while open and
   * keeps its accounts.
   */
  private readonly isVisitors: boolean;

  constructor(ctx: DurableObjectState, env: MailroomEnv) {
    super(ctx, env);
    this.demo = demoSettings(env.DEMO_MAILBOX, env.DEMO_MAILBOX_AT, env.DEMO_HOST_FILES_SENT);
    this.windDown = windDownOf(env.REST_AFTER_DAYS, env.ERASE_AFTER_DAYS);
    this.isVisitors = Boolean(env.VISITOR_KEY) && this.demo !== undefined;
    this.sql = durableSql(ctx.storage);
    const found = upgrade(this.sql);
    // A Mailroom new, upgraded, or erased counts as opened when it starts, so none rests at once.
    const openedAt = openedAtIn(this.sql);
    this.openedAt = openedAt ?? Date.now();
    if (openedAt === undefined) this.writeOpened(this.openedAt);
    this.store = envelopeIndex(this.sql, () => this.book.all().map((account) => account.address));
    this.book = accountBook(this.sql);
    this.avatars = avatarCache(this.sql);
    const credentials = credentialsOf(env.CREDENTIALS_KEY, this.member);
    const hint = (hint: Hint) => this.hint(hint);
    const check = (account: AccountId) => this.owe(() => this.queue.check(account));
    this.connections = connections({
      book: this.book,
      credentials,
      demo: this.demo,
      authServersStandIn: env.AUTH_SERVERS_STAND_IN,
      accessToken: (account) => this.signingIn.accessToken(account),
      imapCode: () => this.imapCode(),
      reached: (provider) => this.reached(provider),
    });
    this.signingIn = signingIn({
      sql: this.sql,
      book: this.book,
      credentials,
      settings: env,
      isDemo: this.demo !== undefined,
      checkSignIn: (...args) => this.connections.checkSignIn(...args),
      disconnect: (account) => this.disconnect(account),
      unwatch: (account) => this.unwatch(account),
      setStatus: (account, status) => this.connected.setStatus(account, status),
      hint,
      check,
      wakeBy: (at) => this.wakeBy(at),
    });
    this.connected = connectedAccounts({
      book: this.book,
      credentials,
      demo: this.demo,
      checkSignIn: (...args) => this.connections.checkSignIn(...args),
      hint,
      check,
    });
    const provider = (account: AccountId) => this.connections.provider(account);
    const signersOf = (account: AccountId) => this.connections.signersOf(account);
    this.fullText = fullTextSearch({ book: this.book, store: this.store, provider });
    this.bodies = bodyCache({
      bucket: env.BODIES,
      member: this.member,
      sql: this.sql,
      store: this.store,
      provider,
      isKnown: (ref) => this.fullText.known(ref) !== undefined,
      signersOf,
    });
    this.oneClick = oneClick({
      bytes: (ref) => this.bodies.bytes(ref),
      signersOf,
      demoLists: (account) => this.connections.demoLists(account),
      standIn: env.UNSUBSCRIBE_STAND_IN,
    });
    this.notifying = notifying(this.sql);
    this.queue = syncQueue({
      sql: this.sql,
      store: this.store,
      hint,
      provider,
      window: (account) => this.connected.windowOf(account),
      settled: (account, error) => {
        if (error) report(error);
        // An account that needs signing in again stays so until the member does.
        if (this.book.get(account)?.account.status === 'needs-sign-in') return;
        this.connected.setStatus(account, error ? 'error' : 'ready');
      },
      landed: (folder, events) => {
        this.noteNews(folder, events);
        this.avatars.note(verifiedSenders(events), Date.now());
      },
    });
    this.sending = outboxQueue({
      sql: this.sql,
      provider,
      hint,
      sent: ({ draft }) => {
        this.queue.folder({ account: draft.account, path: draft.path });
        const sent = this.store.withRole(draft.account, 'sent');
        if (sent) this.queue.folder(folderRef(sent));
      },
      accepted: () => this.accepted(),
    });
    this.drafts = savingDrafts({
      sql: this.sql,
      book: this.book,
      store: this.store,
      provider,
      bodies: this.bodies,
      known: (ref) => this.fullText.known(ref),
      outbox: this.sending,
      sync: this.queue,
      owe: (owing) => this.owe(owing),
      flush: () => this.ctx.storage.sync(),
    });
    this.outboxCommands = outboxCommands({
      queue: this.sending,
      drafts: this.drafts,
      book: this.book,
      store: this.store,
      wakeBy: (at) => this.wakeBy(at),
    });
    const owe = (owing: () => void) => this.owe(owing);
    this.folderCommands = folderCommands({ book: this.book, provider, sync: this.queue, owe });
    this.messageCommands = messageCommands({
      book: this.book,
      store: this.store,
      provider,
      sync: this.queue,
      owe,
      movedIn: (ref) => this.noteMovedIn(ref),
    });
    // Every wake is a cold start, and this is where one begins: a send found mid-submit was cut
    // short by whatever ended the last instance.
    this.sending.recover();
    // A sign-in being checked as the last instance ended lost its tokens with it.
    this.signingIn.recover(Date.now());
    if (found === 0 && this.demo) {
      this.connected.addDemo();
      this.connected.addDemo();
      // The first look shows mail at once, rather than an empty Inbox until the alarm, a hint and
      // a second ask. The alarm fills the rest, whether or not a device opens.
      void ctx.blockConcurrencyWhile(() => this.firstLook());
      void ctx.storage.setAlarm(Date.now());
    }
  }

  /**
   * Runs a query or command a browser sent, and says how long it took to reach this Mailroom and to
   * run here, for the response's Server-Timing.
   */
  async answer(
    { name, args }: Call<QueryName | CommandName>,
    sentAt: number,
    received?: number,
  ): Promise<Answered> {
    if (!CALLABLE.has(name))
      throw new TypeError('That isn’t something a browser can ask its Mailroom.');
    this.noteOpened();
    const reached = Date.now() - sentAt;
    const cold = !this.isRunning;
    this.isRunning = true;
    const started = Date.now();
    const methods = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const spent = new Map<ImapPart, number>();
    const value = await calling.run({ spent, received }, () => methods[name]!(...args));
    const ran = Date.now() - started;
    const parts = IMAP_PARTS.filter((part) => spent.has(part));
    return {
      value,
      reached,
      ran,
      cold,
      spent: parts.map((part) => ({ name: part, ms: spent.get(part)! })),
    };
  }

  // Queries

  accounts(): Promise<Account[]> {
    return Promise.resolve(this.book.all());
  }

  folders(): Promise<Folder[]> {
    return Promise.resolve(this.store.folders());
  }

  async conversations(view: View, at?: PageAt, keep?: ConversationId): Promise<Page> {
    const checked = input.viewOf(view);
    const asked = input.pageAtOf(at);
    if (checked.in === 'outbox') throw new TypeError('The Outbox is listed by outbox().');
    if (checked.in !== 'search') {
      return this.named(this.store.page(checked, asked, undefined, input.keptOf(keep)));
    }
    if (!checked.fullText) return this.named(this.store.search(checked.text, asked));
    return this.named(await this.fullText.page(checked.text, asked));
  }

  people(typed: string): Promise<Address[]> {
    return Promise.resolve(this.store.people(input.typedOf(typed)));
  }

  bundle(id: BundleId, at?: PageAt): Promise<BundlePage> {
    const page = this.store.bundle(input.bundleOf(id), input.pageAtOf(at));
    const pictures = this.pictures(
      avatarCandidates([...page.items, ...(page.bundle ? [page.bundle] : [])]),
    );
    return Promise.resolve({
      ...page,
      items: namedRows(page.items, pictures),
      ...(page.bundle ? { bundle: namedRows([page.bundle], pictures)[0] } : {}),
    });
  }

  conversation(id: ConversationId): Promise<Message[]> {
    const messages = this.fullText.conversation(input.conversationOf(id));
    return Promise.resolve(namedMessages(messages, this.pictures(avatarCandidates([], messages))));
  }

  body(ref: MessageRef): Promise<Body> {
    return this.bodies.read(input.refOf(ref));
  }

  outbox(): Promise<Outgoing[]> {
    return Promise.resolve(this.outboxCommands.list());
  }

  signIns(): Promise<SignIn[]> {
    return Promise.resolve(this.signingIn.list());
  }

  signInPresets(): Promise<SignInPreset[]> {
    return Promise.resolve(this.signingIn.presets());
  }

  /**
   * Names what an installed app keeps of this Mailroom with an id made the first time it's asked.
   * An erase deletes it with everything else, so the Mailroom it leaves has a new one. Says too
   * whether the device at `endpoint` is notified, and gives the key to subscribe with.
   */
  async thisDevice(endpoint?: string): Promise<ThisDevice> {
    const asked = endpoint === undefined ? undefined : input.pushEndpointOf(endpoint);
    let cache = await this.ctx.storage.get<string>(CACHE_KEY);
    if (cache === undefined) {
      cache = crypto.randomUUID();
      await this.ctx.storage.put(CACHE_KEY, cache);
    }
    const key = await this.pushKeyNow();
    return {
      cache,
      ...(key ? { pushKey: key.publicKey } : {}),
      notified: asked !== undefined && this.notifying.isNotified(asked),
      ...(this.isVisitors ? { visitor: true as const } : {}),
    };
  }

  // Commands

  addAccount(setup: AccountSetup): Promise<Account> {
    return this.connected.add(input.setupOf(setup));
  }

  /**
   * Starts a sign-in at the preset's vendor, for a new account or for one that needs signing in
   * again. The alarm polls it from here.
   */
  signIn(to: SignInSetup | AccountId): Promise<SignIn> {
    return this.signingIn.start(input.signInOf(to));
  }

  updateAccount(
    id: AccountId,
    change: Partial<Pick<Account, 'name' | 'fromName' | 'stamp' | 'signature'>>,
  ): Promise<void> {
    const checked = input.accountChangeOf(change);
    this.connected.update(input.accountOf(id), checked);
    return Promise.resolve();
  }

  async removeAccount(id: AccountId): Promise<void> {
    if (this.isVisitors) throw new Error(VISITORS_KEEP);
    const account = input.accountOf(id);
    if (!this.book.get(account)) return;
    await this.disconnect(account);
    const folders = this.store.folders(account);
    this.sql.transaction(() => {
      this.book.remove(account);
      this.store.forget(account);
      // A picture stays only for a sender of the mail that's left.
      this.avatars.keep(this.store.verifiedSenders());
      this.sending.forget(account);
      this.drafts.forget(account);
      this.signingIn.forget(account);
      this.notifying.forgetAccount(account);
    });
    this.fullText.forget();
    this.hint({ changed: 'accounts' });
    this.hint({ changed: 'folders', account });
    for (const folder of folders)
      this.hint({ changed: 'conversations', folder: folderRef(folder) });
    await this.forgetBodies(`${this.member}/${account}/`);
  }

  allowImages(account: AccountId, sender: string): Promise<void> {
    const address = input.senderOf(sender);
    this.connected.allowImages(input.accountOf(account), address);
    return Promise.resolve();
  }

  setLightPaper(account: AccountId, sender: string, on: boolean): Promise<void> {
    const address = input.senderOf(sender);
    const wanted = input.switchOf(on);
    this.connected.setLightPaper(input.accountOf(account), address, wanted);
    return Promise.resolve();
  }

  /** Leaves the list a message came from, by the one-click offer its body names. */
  unsubscribe(ref: MessageRef): Promise<Unsubscribed> {
    return this.oneClick.unsubscribe(input.refOf(ref));
  }

  eraseEverything(): Promise<void> {
    if (this.isVisitors) return Promise.reject(new Error(VISITORS_KEEP));
    return this.erase();
  }

  /** Forgets everything stored for this member, as asked or once the Mailroom is long unopened. */
  private async erase() {
    const accounts = this.book.all();
    for (const { id } of accounts) await this.disconnect(id);
    this.fullText.forget();
    this.signingIn.clear();
    try {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      upgrade(this.sql);
      // Nothing of the member's stays, not even when they last opened it.
      this.openedAt = Date.now();
      await this.forgetBodies(`${this.member}/`);
    } finally {
      // Once nothing of theirs is left to serve, every device drops what it kept, even if a delete
      // failed partway.
      this.hint({ changed: 'everything' });
    }
  }

  setFlags(messages: MessageRef[] | BundleScope, change: Partial<Flags>): Promise<MessageRef[]> {
    return this.messageCommands.setFlags(messages, change);
  }

  move(messages: MessageRef[] | BundleScope, to: FolderRef | FolderRole): Promise<Moved[]> {
    return this.messageCommands.move(messages, to);
  }

  /** Files a draft in its account's Drafts, in place of the version before it. */
  saveDraft(
    draft: DraftUpload,
    replaces: MessageRef | undefined,
    id: string,
    isAgain: boolean,
  ): Promise<MessageRef> {
    const named = input.saveOf(id);
    const again = input.switchOf(isAgain);
    return this.drafts.save(draft, replaces, named, again);
  }

  /**
   * Schedules a draft, or the last save Send carries in its place, to send when the undo window
   * closes or at a later time. The window opened `waited` milliseconds before the device asked,
   * counted from when the request reached the Worker.
   */
  send(
    draft: MessageRef | LastUpload,
    at: string | undefined,
    waited: number,
    id: string,
  ): Promise<Outgoing> {
    const arrived = Math.min(calling.getStore()?.received ?? Date.now(), Date.now());
    const sent = input.sentOf(draft);
    const when = input.optional(at, input.instantOf);
    const ago = input.waitedOf(waited);
    const press = input.sendOf(id);
    return this.outboxCommands.send(sent, when, ago, press, arrived);
  }

  /** Undo, for a press of Send or the send it scheduled. */
  cancelSend(id: string): Promise<MessageRef | undefined> {
    return this.outboxCommands.undo(input.sendOf(id));
  }

  retrySend(id: string): Promise<Outgoing> {
    return this.outboxCommands.retry(input.sendOf(id));
  }

  createFolder(folder: FolderRef): Promise<void> {
    return this.folderCommands.create(folder);
  }

  renameFolder(folder: FolderRef, to: string): Promise<void> {
    return this.folderCommands.rename(folder, to);
  }

  /**
   * Notifies a device of new Inbox mail from now on, and has the alarm come within the shorter
   * interval that notifying keeps.
   */
  async notifyDevice(subscription: Subscription): Promise<void> {
    const checked = subscriptionOf(subscription);
    if (!(await this.pushKeyNow()))
      throw new Error('Notifications aren’t set up on this Trail Mix.');
    this.notifying.notify(checked, Date.now());
    await this.wakeBy(Date.now() + NOTIFYING_CHECKING_MS);
  }

  forgetDevice(endpoint: string): Promise<void> {
    this.notifying.forget(input.pushEndpointOf(endpoint));
    return Promise.resolve();
  }

  deleteFolder(folder: FolderRef): Promise<void> {
    return this.folderCommands.remove(folder);
  }

  // A message's bytes, for the Worker's routes. Null means the message or part is gone.

  /** A verified sender's picture, from the Avatar cache, by the key a read named it with. */
  avatar(key: string): Promise<Picture | null> {
    this.noteOpened();
    return Promise.resolve(this.avatars.picture(key) ?? null);
  }

  source(ref: MessageRef): Promise<ReadableStream<Uint8Array> | null> {
    this.noteOpened();
    return this.bodies.source(input.refOf(ref));
  }

  part(
    ref: MessageRef,
    attachmentId: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; type: string; name: string } | null> {
    this.noteOpened();
    return this.bodies.part(input.refOf(ref), attachmentId);
  }

  // The hint socket, and staying current

  override fetch(request: Request): Promise<Response> {
    this.isRunning = true;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Promise.resolve(new Response('Hints arrive on a WebSocket.', { status: 426 }));
    }
    const { 0: device, 1: socket } = new WebSocketPair();
    this.ctx.acceptWebSocket(socket);
    this.noteOpened();
    // A device just opened: catch up now, and watch while any device stays open.
    this.background(this.owe(() => this.checkAll()));
    return Promise.resolve(new Response(null, { status: 101, webSocket: device }));
  }

  /**
   * Closes every device's hint socket. The Worker calls it only while the operator removes this
   * member, whose sign-in has just ended, so the devices can't connect again. It isn't a browser's
   * to call.
   */
  closeDevices(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1008, 'Signed out');
      } catch {
        // Already closing.
      }
    }
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
    return Promise.resolve();
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
   * eviction drops what it held in memory. It is also where sync runs: everything else owes sync
   * and sets the alarm for now, so every wake lands a bounded share. The one exception is a new
   * demo Mailroom's first look, a few steps that land before it answers anything.
   */
  override async alarm(): Promise<void> {
    this.isRunning = true;
    await this.wake();
  }

  /**
   * One wake. While a device is open, the alarm fires every minute, which keeps the Mailroom in
   * memory and the Inbox watchers alive. Every account is owed a check every few minutes either
   * way. A wake lands what is owed within its budget, and if more remains, the next wake follows at
   * once and picks up from the stored cursors. Returns how many steps it landed.
   *
   * A Mailroom long unopened rests: it checks no mail and watches nothing, sends only what is due,
   * and sleeps until it erases itself, unless a send is due sooner. Then it erases itself.
   */
  protected async wake(): Promise<number> {
    const idleness = idlenessOf(this.openedAt, Date.now(), this.windDown);
    if (idleness === 'erasing') {
      await this.erase();
      return 0;
    }
    // A sign-in polls first, so a long sync never keeps a member waiting on their code.
    await this.signingIn.poll();
    const accounts = this.book.all();
    if (accounts.length === 0) {
      const signInAt = this.signingIn.nextWake();
      if (signInAt !== undefined) await this.ctx.storage.setAlarm(signInAt);
      return 0;
    }
    if (idleness === 'resting') {
      for (const id of [...this.watchers.keys()]) this.unwatch(id);
      await this.sending.run(() => new Date().toISOString());
      const erase = erasesAt(this.openedAt, this.windDown);
      await this.ctx.storage.setAlarm(Math.min(erase, this.sending.nextWake() ?? erase));
      return 0;
    }
    const open = this.devices() > 0;
    const now = Date.now();
    const { pollAt: poll, isCheckDue } = scheduleOf(
      {
        now,
        isWatched: open,
        isNotifying: this.notifying.isAnyNotified(),
        isVisitors: this.isVisitors,
        checkedAt: this.checkedAt,
        openedAt: this.openedAt,
      },
      this.windDown,
    );
    // If this wake ends early, as an eviction would end it, the next one is already set.
    await this.ctx.storage.setAlarm(
      Math.min(poll, this.sending.nextWake() ?? poll, this.signingIn.nextWake() ?? poll),
    );
    // A send that is due goes before sync, which can wait.
    await this.sending.run(() => new Date().toISOString());
    // And so do the drafts newer versions replaced, so sync finds only the newest.
    const failing = await this.drafts.discardReplaced();
    // Timed from the wake's start, as the next alarm is, so the wake it sets always checks.
    if (isCheckDue) this.checkAll(now);
    await this.watchAll(open);
    const landed = await this.queue.run();
    await this.tellNews();
    // A new account's Inbox is known only once its folders are.
    await this.watchAll(this.devices() > 0);
    const isOwingBodies = await this.letBodiesGo().catch((error: unknown) => {
      // What the bucket didn't delete stays owed, for the next wake.
      report(error);
      return false;
    });
    const isSweeping = await this.sweepBodies().catch((error: unknown) => {
      // The sweep picks up where it stopped, at the next wake.
      report(error);
      return false;
    });
    const isOwingAvatars = await this.lookUpAvatars();
    const isResummarizing = this.resummarize();
    const isFillingPeople = this.sql.transaction(() => this.store.fillPeople(PEOPLE_FILLED));
    // A save meanwhile owes a discard, and one whose server failed waits for the next check.
    const isOwingDiscards = this.drafts.owesDiscards(failing);
    const sendAt = this.sending.nextWake() ?? poll;
    if (
      this.queue.owing() ||
      isOwingDiscards ||
      isOwingBodies ||
      isSweeping ||
      isOwingAvatars ||
      isResummarizing ||
      isFillingPeople ||
      sendAt <= Date.now()
    ) {
      await this.ctx.storage.setAlarm(Date.now());
    } else
      await this.ctx.storage.setAlarm(Math.min(poll, sendAt, this.signingIn.nextWake() ?? poll));
    return landed;
  }

  /**
   * Makes a share of the index's rows again from the messages it holds, as an upgrade that changes
   * only what a row derives asks, and hints the folders whose lists changed. Returns whether more
   * remains.
   */
  private resummarize(): boolean {
    const { changed, done } = this.sql.transaction(() => this.store.resummarize(RESUMMARIZED));
    for (const folder of changed) this.hint({ changed: 'conversations', folder });
    return !done;
  }

  /**
   * Looks up the pictures owed, a few each wake, and hints every device when one comes or goes. A
   * wake that asked sites for icons logs how many it found, how many named none, and how many
   * turned the Mailroom away, and names no one. The demo mailbox brings its own and looks nothing up.
   * Returns whether more are owed now, as when mail from many senders arrives at once.
   */
  private async lookUpAvatars(): Promise<boolean> {
    const owed = this.avatars.owed(Date.now(), AVATAR_LOOKUPS);
    if (owed.domains.length + owed.senders.length === 0) return false;
    const sources = this.demo ? demoSources : internetSources(this.avatarNetwork());
    const icons = { found: 0, none: 0, 'turned away': 0 };
    const changed = await Promise.all([
      ...owed.domains.map(async (domain) => {
        try {
          const { logo, icon } = await sources.domain(domain);
          if (icon !== undefined) icons[typeof icon === 'object' ? 'found' : icon] += 1;
          const found: DomainFound = {
            ...(logo ? { logo: await keyed(logo) } : {}),
            ...(icon ? { icon: typeof icon === 'object' ? await keyed(icon) : icon } : {}),
          };
          return this.avatars.foundDomain(domain, found, Date.now());
        } catch (error) {
          report(error);
          this.avatars.failed({ domain }, Date.now());
          return false;
        }
      }),
      ...owed.senders.map(async (sender) => {
        try {
          const photo = await sources.sender(sender);
          return this.avatars.foundSender(sender, photo && (await keyed(photo)), Date.now());
        } catch (error) {
          report(error);
          this.avatars.failed({ sender }, Date.now());
          return false;
        }
      }),
    ]);
    if (!this.demo && icons.found + icons.none + icons['turned away'] > 0) {
      console.log(
        `Mailroom: site icons, ${icons.found} found, ${icons.none} named none, ${icons['turned away']} turned the Mailroom away.`,
      );
    }
    if (changed.includes(true)) this.hint({ changed: 'avatars' });
    const more = this.avatars.owed(Date.now(), { domains: 1, senders: 1 });
    return more.domains.length + more.senders.length > 0;
  }

  /** The internet as this Mailroom reaches it, or a test's stand-in on this machine. */
  private avatarNetwork() {
    const standIn = this.env.AVATARS_STAND_IN;
    return standIn && namesThisMachine(standIn)
      ? avatarNetwork(standInInternet(standIn), true)
      : avatarNetwork(INTERNET);
  }

  /** A page with the pictures the cache holds named, and no others. */
  private named(page: Page): Page {
    return { ...page, items: namedRows(page.items, this.pictures(avatarCandidates(page.items))) };
  }

  /** The key of each sender's picture the cache holds, by sender. */
  private pictures(senders: readonly string[]): Map<string, string> {
    return this.avatars.pictures(senders);
  }

  /**
   * A new demo Mailroom's first steps, which land before it answers anything: each account's
   * folders, then each Inbox's newest batch, which sync lands ahead of any other folder's. The
   * unified Inbox's first page then holds conversations it will once the Mailroom is full, and
   * the older mail that lands later fills it out.
   */
  private async firstLook(): Promise<void> {
    this.checkAll();
    await this.queue.run({ steps: 2 * this.book.all().length, ms: WAKE.ms }).catch(report);
  }

  private checkAll(at = Date.now()) {
    this.checkedAt = at;
    for (const { id } of this.book.all()) this.queue.check(id);
  }

  /**
   * A signed-in device asked for something. It is written down at most hourly. A resting Mailroom
   * wakes at once, to check mail from where it stopped.
   */
  private noteOpened() {
    const now = Date.now();
    if (!isWorthNoting(this.openedAt, now)) return;
    const wasResting = idlenessOf(this.openedAt, now, this.windDown) !== 'open';
    this.writeOpened(now);
    if (wasResting) this.background(this.owe(() => this.checkAll()));
  }

  protected writeOpened(at: number) {
    this.openedAt = at;
    this.sql.run(`INSERT OR REPLACE INTO opened (one, at) VALUES (1, ?)`, at);
  }

  /** Has the alarm come by `at`, unless it is already set to come sooner. */
  private async wakeBy(at: number) {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  /** Runs once the host has accepted a message and before the Outbox records it. */
  protected accepted(): void {}

  /**
   * The IMAP provider's code, which this isolate loads the first time it signs in to or reaches a
   * mail server. A test's Mailroom counts the loads here.
   */
  protected imapCode(): Promise<ImapCode> {
    return loadImapCode();
  }

  /** The provider an account is reached through, as it's made. A test's Mailroom watches it here. */
  protected reached(provider: MailProvider): MailProvider {
    return provider;
  }

  /** Owes sync, and has the next wake land it at once. */
  private async owe(owing: () => void) {
    owing();
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async watchAll(open: boolean) {
    for (const { id, status } of this.book.all()) {
      if (open && status !== 'needs-sign-in') await this.watch(id).catch(report);
      else this.unwatch(id);
    }
  }

  private async watch(account: AccountId) {
    if (this.watchers.has(account)) return;
    const inbox = this.store.withRole(account, 'inbox');
    if (!inbox) return;
    const provider = await this.connections.provider(account);
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

  /**
   * Notes the news in a batch an Inbox's sync landed, to tell once the wake's sync is done, and
   * moves the Inbox's mark on. Marks move whether or not a device is notified, so turning
   * notifications on finds every Inbox already read.
   */
  private noteNews(folder: FolderRef, events: readonly SyncEvent[]) {
    if (this.store.reads.role(folder) !== 'inbox') return;
    const held = this.notifying.mark(folder);
    const { news, mark } = newsIn(events, held, {
      now: Date.now(),
      movedIn: (ref) => this.movedIn.delete(refKey(ref)),
    });
    if (mark && (mark.uid !== held?.uid || mark.uidValidity !== held.uidValidity)) {
      this.notifying.setMark(folder, mark);
    }
    if (news.length === 0 || !this.notifying.isAnyNotified()) return;
    for (const envelope of news) {
      const message = this.store.reads.message(envelope);
      if (message) this.news.push(message);
    }
  }

  /**
   * Tells every notified device the news this wake's sync folded. A device whose subscription has
   * ended is forgotten. A push that fails costs that notice and nothing more, and never the wake.
   */
  private async tellNews() {
    const news = this.news;
    this.news = [];
    const key = news.length > 0 ? await this.pushKeyNow() : undefined;
    if (!key) return;
    const notices = noticesOf(news, (id) => this.book.get(id)?.account.name);
    for (const device of this.notifying.devices()) {
      try {
        for (const notice of notices) {
          const fared = await deliver(device, pushOf(notice), key, (request) =>
            this.postPush(request),
          );
          if (fared === 'gone') {
            this.notifying.forget(device.endpoint);
            break;
          }
          if (fared === 'refused') {
            report(new Error('A push service refused this deployment’s key.'));
          }
        }
      } catch (error) {
        report(error);
      }
    }
  }

  /** A message the member moved, which isn't news if its move lands it in an Inbox. */
  private noteMovedIn(ref: MessageRef) {
    this.movedIn.add(refKey(ref));
    for (const oldest of this.movedIn) {
      if (this.movedIn.size <= MOVED_IN_HELD) break;
      this.movedIn.delete(oldest);
    }
  }

  /**
   * The deployment's push key, or nothing where notifications are off. A key that can't be read is
   * reported, and leaves notifications off and everything else working.
   */
  private pushKeyNow(): Promise<PushKey | undefined> {
    const { PUSH_KEY: pem, OPERATOR_EMAIL: operator } = this.env;
    this.pushKey ??=
      pem && operator
        ? pushKeyOf(pem, operator).catch((error: unknown) => {
            report(error);
            return undefined;
          })
        : Promise.resolve(undefined);
    return this.pushKey;
  }

  /** Posts a push to its push service. A test's Mailroom keeps it instead. */
  protected postPush(request: Request): Promise<Response> {
    return fetch(request);
  }

  // Providers and the body cache

  /** A preset, with a test's stand-ins for its vendor when the test gave them. */
  protected preset(name: PresetName): Preset {
    return this.signingIn.preset(name);
  }

  /** Forgets what an account owes, so a step of it under way lands nothing, and closes its provider. */
  private async disconnect(account: AccountId) {
    this.queue.forget(account);
    this.unwatch(account);
    await this.connections.close(account);
  }

  protected get member() {
    return this.ctx.id.toString();
  }

  protected forgetBodies(prefix: string): Promise<void> {
    return this.bodies.forget(prefix);
  }

  protected letBodiesGo(): Promise<boolean> {
    return this.bodies.letGo();
  }

  protected sweepBodies(batches?: BodyBatches): Promise<boolean> {
    return this.bodies.sweep(batches);
  }

  /** Work the caller doesn't wait for. Its failure is logged, and the next check tries again. */
  private background(work: Promise<unknown>) {
    this.ctx.waitUntil(work.catch(report));
  }
}

/** What a browser may ask, and nothing else the Mailroom answers to. */
const CALLABLE: ReadonlySet<string> = new Set([...QUERIES, ...COMMANDS]);

/**
 * The browser's call running now: where its time went on its mail servers, by part, and when its
 * request reached the Worker. Calls interleave at each wait, so each keeps its own, and the wake's
 * work, which no call runs, none.
 */
const calling = new AsyncLocalStorage<{ spent: Map<ImapPart, number>; received?: number }>();
const IMAP_PARTS: readonly ImapPart[] = ['connect', 'imap', 'folder'];

let imapLoaded: Promise<ImapCode> | undefined;

/**
 * Loads the IMAP provider's code and workerd's sockets when this isolate first needs them, so one
 * that never reaches a mail server, as every demo Mailroom and the Worker's own isolates don't,
 * never runs the mail libraries. A load that fails is tried again the next time.
 */
function loadImapCode(): Promise<ImapCode> {
  imapLoaded ??= Promise.all([imap(), import('imapflow')]).then(
    ([code, { createSocketsTransport }]) => ({
      code,
      network: {
        // Its types want `allowHalfOpen` given.
        imapTransport: createSocketsTransport((address, options) =>
          connect(
            address,
            options && { ...options, allowHalfOpen: options.allowHalfOpen ?? false },
          ),
        ),
        spent: (part, ms) => {
          const spent = calling.getStore()?.spent;
          spent?.set(part, (spent.get(part) ?? 0) + ms);
        },
      },
    }),
    (error: unknown) => {
      imapLoaded = undefined;
      throw error;
    },
  );
  return imapLoaded;
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

/** When a signed-in device last asked this Mailroom for something, as storage holds it. */
function openedAtIn(sql: Sql): number | undefined {
  const [row] = sql.all<{ at: number }>(`SELECT at FROM opened`);
  return row?.at;
}
