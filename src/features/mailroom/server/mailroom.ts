import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import {
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
  type View,
} from '../../mail/core/index.ts';
import { subscriptionOf, type Subscription } from '../../notifications/core/index.ts';
import {
  imap,
  type ImapPart,
  type MailProvider,
  type Preset,
  type PresetName,
} from '../../providers/index.ts';
import {
  COMMANDS,
  QUERIES,
  type AccountChange,
  type AccountSetup,
  type Answered,
  type BundlePage,
  type BundleScope,
  type Call,
  type CommandName,
  type DraftUpload,
  type LastUpload,
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
} from '../core/idle.ts';
import { verifiedSenders, type Picture } from '../core/avatars.ts';
import { accountBook, connectedAccounts, demoSettings } from './accounts.ts';
import { bodyCache, type BodyBatches } from './bodies.ts';
import { connections, type ImapCode } from './connections.ts';
import { credentialsOf } from './credentials.ts';
import { savingDrafts } from './drafts.ts';
import { folderCommands } from './folders.ts';
import { notifying } from './notifying.ts';
import { envelopeIndex } from './envelope-index.ts';
import * as input from './input.ts';
import { messageCommands } from './messages.ts';
import { avatars } from './avatars.ts';
import { upgrade, type Sql, type SqlValue } from './schema.ts';
import { outboxCommands, outboxQueue } from './outbox.ts';
import { fullTextSearch } from './search.ts';
import { signingIn } from './sign-ins.ts';
import { report } from './report.ts';
import { syncQueue, WAKE } from './sync.ts';
import { oneClick } from './unsubscribe.ts';

/** Why a visitor's Mailroom keeps what it holds. */
const VISITORS_KEEP =
  'The demo keeps its two accounts, and erases itself a day after your last visit.';
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
export class Mailroom extends DurableObject implements Contract {
  private readonly demo = demoSettings(
    this.env.DEMO_MAILBOX,
    this.env.DEMO_MAILBOX_AT,
    this.env.DEMO_HOST_FILES_SENT,
  );
  /** How long unopened before it rests, and before it erases itself. */
  private readonly windDown = windDownOf(this.env.REST_AFTER_DAYS, this.env.ERASE_AFTER_DAYS);
  /**
   * Whether this is a visitor's Mailroom on the public demo, which checks mail only while open and
   * keeps its accounts.
   */
  private readonly isVisitors = Boolean(this.env.VISITOR_KEY) && this.demo !== undefined;
  protected readonly sql = durableSql(this.ctx.storage);
  /** The version storage was at when this instance woke, which is 0 for a new Mailroom. */
  private readonly found = upgrade(this.sql);
  /** When a signed-in device last asked for something, as storage holds it. */
  protected openedAt: number;
  /** Whether this instance has had anything to do yet, so the first call can say it started it. */
  private isRunning = false;
  // Each part below is made from the ones above it, and reaches a later one only through a closure.
  protected readonly store = envelopeIndex(this.sql, () =>
    this.book.all().map((account) => account.address),
  );
  private readonly book = accountBook(this.sql);
  private readonly credentials = credentialsOf(this.env.CREDENTIALS_KEY, this.member);
  private readonly avatars = avatars({
    sql: this.sql,
    hint: (hint) => this.hint(hint),
    isDemo: this.demo !== undefined,
    standIn: this.env.AVATARS_STAND_IN,
  });
  private readonly connections = connections({
    book: this.book,
    credentials: this.credentials,
    demo: this.demo,
    authServersStandIn: this.env.AUTH_SERVERS_STAND_IN,
    accessToken: (account) => this.signingIn.accessToken(account),
    imapCode: () => this.imapCode(),
    reached: (provider) => this.reached(provider),
  });
  private readonly signingIn = signingIn({
    sql: this.sql,
    book: this.book,
    credentials: this.credentials,
    settings: this.env,
    isDemo: this.demo !== undefined,
    checkSignIn: (...args) => this.connections.checkSignIn(...args),
    disconnect: (account) => this.disconnect(account),
    unwatch: (account) => this.queue.unwatch(account),
    setStatus: (account, status) => this.connected.setStatus(account, status),
    hint: (hint) => this.hint(hint),
    check: (account) => this.owe(() => this.queue.check(account)),
    wakeBy: (at) => this.wakeBy(at),
  });
  private readonly connected = connectedAccounts({
    book: this.book,
    credentials: this.credentials,
    demo: this.demo,
    checkSignIn: (...args) => this.connections.checkSignIn(...args),
    hint: (hint) => this.hint(hint),
    check: (account) => this.owe(() => this.queue.check(account)),
  });
  private readonly fullText = fullTextSearch({
    book: this.book,
    store: this.store,
    provider: (account) => this.connections.provider(account),
  });
  private readonly bodies = bodyCache({
    bucket: this.env.BODIES,
    member: this.member,
    sql: this.sql,
    store: this.store,
    provider: (account) => this.connections.provider(account),
    isKnown: (ref) => this.fullText.known(ref) !== undefined,
    signersOf: (account) => this.connections.signersOf(account),
  });
  private readonly oneClick = oneClick({
    bytes: (ref) => this.bodies.bytes(ref),
    signersOf: (account) => this.connections.signersOf(account),
    demoLists: (account) => this.connections.demoLists(account),
    standIn: this.env.UNSUBSCRIBE_STAND_IN,
  });
  private readonly notifying = notifying({
    sql: this.sql,
    reads: this.store.reads,
    nameOf: (account) => this.book.get(account)?.account.name,
    settings: this.env,
    post: (request) => this.postPush(request),
  });
  protected readonly queue = syncQueue({
    sql: this.sql,
    store: this.store,
    hint: (hint) => this.hint(hint),
    provider: (account) => this.connections.provider(account),
    window: (account) => this.connected.windowOf(account),
    settled: (account, error) => {
      if (error) report(error);
      // An account that needs signing in again stays so until the member does.
      if (this.book.get(account)?.account.status === 'needs-sign-in') return;
      this.connected.setStatus(account, error ? 'error' : 'ready');
    },
    landed: (folder, events) => {
      this.notifying.note(folder, events);
      this.avatars.note(verifiedSenders(events), Date.now());
    },
    wakeNow: () => this.background(this.ctx.storage.setAlarm(Date.now())),
  });
  protected readonly sending = outboxQueue({
    sql: this.sql,
    provider: (account) => this.connections.provider(account),
    hint: (hint) => this.hint(hint),
    sent: ({ draft }) => {
      this.queue.folder({ account: draft.account, path: draft.path });
      const sent = this.store.withRole(draft.account, 'sent');
      if (sent) this.queue.folder(folderRef(sent));
    },
    accepted: () => this.accepted(),
  });
  private readonly drafts = savingDrafts({
    sql: this.sql,
    book: this.book,
    store: this.store,
    provider: (account) => this.connections.provider(account),
    bodies: this.bodies,
    known: (ref) => this.fullText.known(ref),
    outbox: this.sending,
    sync: this.queue,
    owe: (owing) => this.owe(owing),
    flush: () => this.ctx.storage.sync(),
  });
  protected readonly outboxCommands = outboxCommands({
    queue: this.sending,
    drafts: this.drafts,
    book: this.book,
    store: this.store,
    wakeBy: (at) => this.wakeBy(at),
  });
  private readonly folderCommands = folderCommands({
    book: this.book,
    provider: (account) => this.connections.provider(account),
    sync: this.queue,
    owe: (owing) => this.owe(owing),
  });
  private readonly messageCommands = messageCommands({
    book: this.book,
    store: this.store,
    provider: (account) => this.connections.provider(account),
    sync: this.queue,
    owe: (owing) => this.owe(owing),
    movedIn: (ref) => this.notifying.movedIn(ref),
  });

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // A Mailroom new, upgraded, or erased counts as opened when it starts, so none rests at once.
    const [opened] = this.sql.all<{ at: number }>(`SELECT at FROM opened`);
    this.openedAt = opened?.at ?? Date.now();
    if (!opened) this.writeOpened(this.openedAt);
    // Every wake is a cold start, and this is where one begins: a send found mid-submit was cut
    // short by whatever ended the last instance.
    this.sending.recover();
    // A sign-in being checked as the last instance ended lost its tokens with it.
    this.signingIn.recover(Date.now());
    if (this.found === 0 && this.demo) {
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
      return this.avatars.page(this.store.page(checked, asked, undefined, input.keptOf(keep)));
    }
    if (!checked.fullText) return this.avatars.page(this.store.search(checked.text, asked));
    return this.avatars.page(await this.fullText.page(checked.text, asked));
  }

  people(typed: string): Promise<Address[]> {
    return Promise.resolve(this.store.people(input.typedOf(typed)));
  }

  bundle(id: BundleId, at?: PageAt): Promise<BundlePage> {
    const page = this.store.bundle(input.bundleOf(id), input.pageAtOf(at));
    return Promise.resolve(this.avatars.bundle(page));
  }

  conversation(id: ConversationId): Promise<Message[]> {
    const messages = this.fullText.conversation(input.conversationOf(id));
    return Promise.resolve(this.avatars.conversation(messages));
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
    const pushKey = await this.notifying.publicKey();
    return {
      cache,
      ...(pushKey ? { pushKey } : {}),
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

  updateAccount(id: AccountId, change: AccountChange): Promise<void> {
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
      // From compatibility date 2026-02-24, deleting everything deletes the alarm too.
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
    return this.drafts.save(draft, replaces, input.saveOf(id), input.switchOf(isAgain));
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
    await this.notifying.notify(subscriptionOf(subscription), Date.now());
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
    this.background(this.owe(() => this.queue.checkAll(this.book.all())));
    return Promise.resolve(new Response(null, { status: 101, webSocket: device }));
  }

  override webSocketMessage(): void {
    // Devices only listen.
  }

  override webSocketClose(socket: WebSocket): void {
    if (this.devices(socket) === 0) this.queue.unwatchAll();
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
      this.queue.unwatchAll();
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
        checkedAt: this.queue.checkedAt(),
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
    if (isCheckDue) this.queue.checkAll(this.book.all(), now);
    await this.queue.watch(this.book.all(), open);
    const landed = await this.queue.run();
    await this.notifying.tell();
    // A new account's Inbox is known only once its folders are.
    await this.queue.watch(this.book.all(), this.devices() > 0);
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
    const isOwingAvatars = await this.avatars.lookUp();
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
   * A new demo Mailroom's first steps, which land before it answers anything: each account's
   * folders, then each Inbox's newest batch, which sync lands ahead of any other folder's. The
   * unified Inbox's first page then holds conversations it will once the Mailroom is full, and
   * the older mail that lands later fills it out.
   */
  private async firstLook(): Promise<void> {
    this.queue.checkAll(this.book.all());
    await this.queue.run({ steps: 2 * this.book.all().length, ms: WAKE.ms }).catch(report);
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
    if (wasResting) this.background(this.owe(() => this.queue.checkAll(this.book.all())));
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
    this.queue.unwatch(account);
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
  return {
    all: <Row>(query: string, ...params: SqlValue[]) =>
      storage.sql.exec(query, ...params).toArray() as Row[],
    each: <Row>(query: string, ...params: SqlValue[]) =>
      storage.sql.exec(query, ...params) as Iterable<Row>,
    run: (query, ...params) => void storage.sql.exec(query, ...params).toArray(),
    transaction: (work) => storage.transactionSync(work),
  };
}

const folderRef = ({ account, path }: FolderRef): FolderRef => ({ account, path });
