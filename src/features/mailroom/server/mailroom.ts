import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import PostalMime, { type Address as PostalAddress } from 'postal-mime';
import * as signing from '../../accounts/core/index.ts';
import { messageOf } from '../../composer/index.ts';
import { createProblem, deleteProblem, inside, renameProblem } from '../../folders/core/index.ts';
import {
  messageIdOf,
  oneClickUnsubscribe,
  referencesOf,
  sameRef,
  writeMime,
  type Account,
  type AccountId,
  type Address,
  type Body,
  type BundleId,
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
import { closesAfterPress, UNDO_SECONDS } from '../../outbox/core/index.ts';
import {
  DEMO_ACCOUNTS,
  DEMO_SIGNERS,
  PRESETS,
  authServersFor,
  codeFrom,
  codeRequest,
  demoMailbox,
  demoServer,
  imap,
  isFresh,
  namesThisMachine,
  pollRequest,
  polled,
  refreshRequest,
  refreshed,
  withStandIn,
  type Answer,
  type Client,
  type DemoKind,
  type DemoServer,
  type DeviceSignIn,
  type ImapAccount,
  type ImapPart,
  type MailProvider,
  type Moved,
  type Network,
  type Polled,
  type Preset,
  type PresetName,
  type Request as VendorRequest,
  type SyncWindow,
  type Tokens,
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
import { erasesAt, idlenessOf, isWorthNoting, windDownOf, type WindDown } from '../core/idle.ts';
import {
  avatarCandidates,
  namedMessages,
  namedRows,
  verifiedSenders,
  type Picture,
} from '../core/avatars.ts';
import {
  accountBook,
  connectionOf,
  demoSettings,
  type AccountBook,
  type Connection,
  type DemoSettings,
} from './accounts.ts';
import { memberKey, open, seal } from './credentials.ts';
import { notifying, type Notifying } from './notifying.ts';
import { envelopeIndex, pageAfter, type EnvelopeIndex } from './envelope-index.ts';
import * as input from './input.ts';
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
import { outboxQueue, type OutboxQueue } from './outbox.ts';
import { replacedDrafts, type ReplacedDrafts } from './replaced.ts';
import { foundOf, opened, type Found } from './search.ts';
import { signInBook, type SignInBook } from './sign-ins.ts';
import { syncQueue, WAKE, type SyncQueue } from './sync.ts';
import { headerOf, internet, unsubscribeAt } from './unsubscribe.ts';

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

/** Where each preset that can sign in finds the operator's app in the Worker's settings. */
const APPS = {
  outlook: { id: 'MICROSOFT_CLIENT_ID', standIn: 'OUTLOOK_STAND_IN' },
} as const satisfies Record<SignInPreset, { id: keyof MailroomEnv; standIn: keyof MailroomEnv }>;

/** How long a vendor has to answer one request of a sign-in. */
const VENDOR_PATIENCE_MS = 15_000;

/** How far back mail is indexed. Older mail stays on the server. */
const WINDOW_DAYS = 365;
/** While a device is open, the alarm keeps the Mailroom awake and its watchers alive. */
const WATCHING_MS = 60_000;
/** Every account is checked this often, whether or not a device is open. */
const CHECKING_MS = 5 * 60_000;

/** Why a visitor's Mailroom keeps what it holds. */
const VISITORS_KEEP =
  'The demo keeps its two accounts, and erases itself a day after your last visit.';
/**
 * How often while any device is notified, so mail that lands just after a check still reaches it
 * within five minutes, with the sync and the push service's share of the time.
 */
const NOTIFYING_CHECKING_MS = 4 * 60_000;
/**
 * How early an alarm may come by this instance's clock, since a Durable Object may wake on another
 * machine, so a check it is due doesn't slip a whole interval.
 */
const ALARM_SLACK_MS = 1_000;
/** How many refs of messages the member moved into an Inbox are held, oldest dropped first. */
const MOVED_IN_HELD = 1_000;
/** The most domains and senders one wake looks up pictures for. */
const AVATAR_LOOKUPS = { domains: 6, senders: 16 };
/** The most cached bodies one wake lets go, in deletes of at most as many keys as a bucket takes. */
const BODIES_LET_GO = { wake: 10_000, delete: 1_000 };
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
  /** Sign-ins at a vendor while members enter their codes. */
  private readonly underWay: SignInBook;
  /** Each signed-in account's access token while it's fresh. Only memory holds them. */
  private readonly tokens = new Map<AccountId, Tokens>();
  /** A refresh under way per account, so connections opening at once share it. */
  private readonly refreshing = new Map<AccountId, Promise<Tokens>>();
  private readonly providers = new Map<AccountId, Promise<MailProvider>>();
  /** The demo's world beyond each demo account's provider, made with it: its list servers. */
  private readonly demoServers = new Map<AccountId, DemoServer>();
  private readonly watchers = new Map<AccountId, () => void>();
  protected readonly queue: SyncQueue;
  protected readonly sending: OutboxQueue;
  private readonly replaced: ReplacedDrafts;
  /** When every account was last owed a check. A cold start checks at its first wake. */
  private checkedAt = 0;
  /** When a signed-in device last asked for something, as storage holds it. */
  protected openedAt: number;
  /** How long unopened before it rests, and before it erases itself. */
  private readonly windDown: WindDown;
  private key: Promise<CryptoKey> | undefined;
  /** The last full-text search. Only memory holds it, so a restart forgets it. */
  private found: Found | undefined;
  /** Drafts this Mailroom filed, whose attachments the next version may carry before sync sees it. */
  private readonly drafts = new Set<string>();
  /** Sends whose last save is being filed, by the press that named them. Memory alone holds them. */
  protected readonly handing = new Map<string, Handing>();
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
    this.underWay = signInBook(this.sql);
    this.notifying = notifying(this.sql);
    this.queue = syncQueue({
      sql: this.sql,
      store: this.store,
      hint: (hint) => this.hint(hint),
      provider: (account) => this.provider(account),
      window: (account) => this.windowOf(account),
      settled: (account, error) => {
        if (error) report(error);
        // An account that needs signing in again stays so until the member does.
        if (this.book.get(account)?.account.status === 'needs-sign-in') return;
        this.setStatus(account, error ? 'error' : 'ready');
      },
      landed: (folder, events) => {
        this.noteNews(folder, events);
        this.avatars.note(verifiedSenders(events), Date.now());
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
    this.replaced = replacedDrafts(this.sql);
    // Every wake is a cold start, and this is where one begins: a send found mid-submit was cut
    // short by whatever ended the last instance.
    this.sending.recover();
    // A sign-in being checked as the last instance ended lost its tokens with it.
    const now = Date.now();
    for (const pending of this.underWay.all(now)) {
      const recovered = signing.recover(pending, now);
      if (recovered !== pending) this.underWay.update(recovered);
    }
    if (found === 0 && this.demo) {
      this.addDemo();
      this.addDemo();
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
  async answer({ name, args }: Call<QueryName | CommandName>, sentAt: number): Promise<Answered> {
    if (!CALLABLE.has(name))
      throw new TypeError('That isn’t something a browser can ask its Mailroom.');
    this.noteOpened();
    const reached = Date.now() - sentAt;
    const cold = !this.isRunning;
    this.isRunning = true;
    const started = Date.now();
    const methods = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const spent = new Map<ImapPart, number>();
    const value = await spending.run(spent, () => methods[name]!(...args));
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
    // The first page asks the servers again. Pages further down, and a page around a result, read
    // what that one found.
    if (asked === 0 || this.found?.text !== checked.text) {
      this.found = await this.searchServers(checked.text);
    }
    return this.named(pageAfter(this.found.rows, asked));
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
    const messages = opened(input.conversationOf(id), this.store, this.found?.outside ?? []);
    return Promise.resolve(namedMessages(messages, this.pictures(avatarCandidates([], messages))));
  }

  async body(ref: MessageRef): Promise<Body> {
    const bytes = await this.bytes(input.refOf(ref));
    if (!bytes) throw new Error('That message is no longer in this mailbox.');
    const parsed = await PostalMime.parse(bytes);
    const unsubscribe = oneClickUnsubscribe(headerOf(bytes), this.signersOf(ref.account));
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
      ...(unsubscribe ? { unsubscribe } : {}),
    };
  }

  outbox(): Promise<Outgoing[]> {
    return Promise.resolve(this.sending.list().map((outgoing) => this.placed(outgoing)));
  }

  signIns(): Promise<SignIn[]> {
    return Promise.resolve(this.underWay.all(Date.now()).map(signInOf));
  }

  signInPresets(): Promise<SignInPreset[]> {
    const presets = Object.keys(APPS) as SignInPreset[];
    return Promise.resolve(presets.filter((preset) => this.vendor(preset)));
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

  async addAccount(setup: AccountSetup): Promise<Account> {
    const checked = input.setupOf(setup);
    if (checked.provider === 'demo') {
      const account = this.addDemo();
      this.hint({ changed: 'accounts' });
      await this.owe(() => this.queue.check(account.id));
      return account;
    }
    // Preview and demo deployments hold the demo mailbox, and can never reach a real account.
    if (this.demo) throw new Error('This deployment has only the demo mailbox.');
    if (!('password' in checked)) throw new Error('Outlook sign-in arrives with its own step.');
    const address = checked.address.toLowerCase();
    if (this.book.all().some((held) => held.address.toLowerCase() === address)) {
      throw new Error(`${checked.address} is already connected.`);
    }
    const connection = connectionOf(checked);

    // Nothing is kept until both hosts accept the password.
    const id = crypto.randomUUID();
    const { code, network } = await this.imapCode();
    await code.checkSignIn(imapAccount(id, connection, { pass: checked.password }), network);

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

  /**
   * Starts a sign-in at the preset's vendor, for a new account or for one that needs signing in
   * again. The alarm polls it from here.
   */
  async signIn(to: SignInSetup | AccountId): Promise<SignIn> {
    const checked = input.signInOf(to);
    if (this.demo) throw new Error('This deployment has only the demo mailbox.');
    let address: string;
    let preset: PresetName | undefined;
    let pendingTo: signing.Pending['to'];
    if (typeof checked === 'string') {
      const held = this.book.get(checked)?.account;
      if (!held) throw new Error('There is no such account.');
      ({ address, preset } = held);
      pendingTo = { account: held.id };
    } else {
      ({ address, preset } = checked);
      if (this.book.all().some((account) => sameAddress(account.address, address))) {
        throw new Error(`${address} is already connected.`);
      }
      const { name, fromName } = checked;
      pendingTo = { preset: checked.preset, name, ...(fromName ? { fromName } : {}) };
    }
    const vendor = this.vendor(preset);
    if (!vendor) throw new Error(notSetUp(preset));

    const now = Date.now();
    const answer = await this.ask(codeRequest(vendor.signIn, vendor.client));
    const code = codeFrom(vendor.signIn, answer, now);
    const pending = signing.started(address, pendingTo, code, now);
    const sealed = await seal(await this.memberKey(), code.deviceCode, deviceCodeOf(address));
    this.underWay.start(pending, sealed);
    this.hint({ changed: 'accounts' });
    await this.wakeBy(pending.pollAt);
    return signInOf(pending);
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
      this.replaced.forget(account);
      this.underWay.forget(account);
      this.notifying.forgetAccount(account);
    });
    this.tokens.delete(account);
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

  setLightPaper(account: AccountId, sender: string, on: boolean): Promise<void> {
    const address = input.senderOf(sender);
    const wanted = input.switchOf(on);
    const known = this.book.update(input.accountOf(account), (held) => {
      const others = held.lightPaperFrom.filter((each) => each !== address);
      return { ...held, lightPaperFrom: wanted ? [...others, address] : others };
    });
    if (!known) throw new Error('There is no such account.');
    this.hint({ changed: 'accounts' });
    return Promise.resolve();
  }

  /**
   * Leaves the list a message came from, by the one-click offer its body names: checked again from
   * the message itself, then posted as `unsubscribeAt` says. The demo's list servers answer it
   * without the network, since nothing in the demo is real.
   */
  async unsubscribe(ref: MessageRef): Promise<Unsubscribed> {
    const message = input.refOf(ref);
    const bytes = await this.bytes(message);
    if (!bytes) throw new Error('That message is no longer in this mailbox.');
    const address = oneClickUnsubscribe(headerOf(bytes), this.signersOf(message.account));
    if (!address) {
      return { taken: false, reason: 'This message doesn’t offer to unsubscribe in one click.' };
    }
    if (this.book.get(message.account)?.connection.provider === 'demo') {
      await this.provider(message.account);
      const lists = this.demoServers.get(message.account);
      if (!lists) throw new Error('There is no such account.');
      return unsubscribeAt(address, (url) => lists.unsubscribe(url.href));
    }
    const standIn = this.env.UNSUBSCRIBE_STAND_IN;
    return unsubscribeAt(
      address,
      internet,
      standIn && namesThisMachine(standIn) ? standIn : undefined,
    );
  }

  eraseEverything(): Promise<void> {
    if (this.isVisitors) return Promise.reject(new Error(VISITORS_KEEP));
    return this.erase();
  }

  /** Forgets everything stored for this member, as asked or once the Mailroom is long unopened. */
  private async erase() {
    const accounts = this.book.all();
    for (const { id } of accounts) await this.disconnect(id);
    this.found = undefined;
    this.tokens.clear();
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

  async setFlags(
    messages: MessageRef[] | BundleScope,
    change: Partial<Flags>,
  ): Promise<MessageRef[]> {
    const checked = input.flagsOf(change);
    const refs = this.refsIn(messages, (scope) =>
      this.store
        .bundled(
          scope.bundle,
          scope.through,
          checked.seen === false || checked.flagged === true ? 'newest' : 'every',
        )
        .filter(({ flags }) =>
          Object.entries(checked).some(([flag, on]) => flags[flag as keyof Flags] !== on),
        ),
    );
    for (const [account, held] of this.byAccount(refs)) {
      await (await this.provider(account)).setFlags(held, checked);
      await this.owe(() => {
        for (const path of new Set(held.map((ref) => ref.path)))
          this.queue.folder({ account, path });
      });
    }
    return refs;
  }

  async move(messages: MessageRef[] | BundleScope, to: FolderRef | FolderRole): Promise<Moved[]> {
    const destination = input.destinationOf(to);
    const refs = this.refsIn(messages, (scope) =>
      this.store.bundled(scope.bundle, scope.through, 'inbox'),
    );
    const moved: Moved[] = [];
    for (const [account, held] of this.byAccount(refs)) {
      const path =
        typeof destination === 'string'
          ? this.pathWithRole(account, destination)
          : destination.path;
      const landed = await (await this.provider(account)).move(held, path);
      for (const { to } of landed) this.noteMovedIn(to);
      moved.push(...landed);
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
   * before it. An attachment that travelled before is read from the message that holds it. A draft
   * is its own authority on what it answers: one that names no parent the index holds, as a draft
   * another client wrote may not, or whose parent went since the last save, keeps the threading of
   * the draft it replaces. Only a first save refuses a parent that has gone.
   */
  async saveDraft(draft: DraftUpload, replaces?: MessageRef): Promise<MessageRef> {
    const filed = await this.fileDraft(draft, replaces);
    await this.keepFiled(filed);
    return filed.saved;
  }

  /**
   * Schedules a draft to send when the undo window closes, or at a later time. The draft stays in
   * Drafts, as it is, until the host accepts it. The window opened when the member pressed Send,
   * `waited` milliseconds before the device asked, and never further back than its own length.
   *
   * Send may carry the message's last save in place of a draft, which is filed first, so a device
   * that closes once it has asked still sends. Then the press names the send by `id`, so asking
   * again answers with the same send, and an Undo while the save is filed keeps it as a draft.
   */
  async send(
    draft: MessageRef | LastUpload,
    at?: string,
    waited?: number,
    id?: string,
  ): Promise<Outgoing> {
    const arrived = Date.now();
    const sent = input.sentOf(draft);
    const when = input.optional(at, input.instantOf);
    const since = Math.min(input.optional(waited, input.waitedOf) ?? 0, UNDO_SECONDS * 1000);
    const press = input.optional(id, input.sendOf);
    const opened = new Date(arrived - since).toISOString();
    if (press !== undefined) {
      const named = this.sending.list().find((held) => held.id === press);
      if (named) return this.placed(named);
      const handing = this.handing.get(press);
      if (handing) return handing.sent;
    }
    if ('save' in sent) {
      if (press === undefined) throw new TypeError('A send that carries its save needs an id.');
      return this.sendLastSave(sent, when, opened, press);
    }
    if (!this.book.get(sent.account)) throw new Error('There is no such account.');
    if (this.store.reads.role(sent) !== 'drafts') throw new Error('Only a draft can be sent.');
    const addressing = await this.addressing(sent);
    const outgoing = this.sending.send(
      { draft: sent, ...addressing },
      new Date().toISOString(),
      when,
      opened,
      press,
    );
    await this.wakeBy(Date.parse(outgoing.sendAt));
    return this.placed(outgoing);
  }

  /**
   * Undo. A send whose last save is still being filed is never scheduled, and its draft is returned
   * once it is saved, while its window is open.
   */
  async cancelSend(id: string): Promise<MessageRef> {
    const press = input.sendOf(id);
    const handing = this.handing.get(press);
    if (!handing || this.sending.list().some((held) => held.id === press)) {
      return this.sending.cancel(press, new Date().toISOString());
    }
    if (Date.now() >= handing.closes) throw new Error('It is being sent, so it can’t be undone.');
    handing.isUndone = true;
    return (await handing.filing).saved;
  }

  /** Files a send's last save, then schedules the draft it made, unless the send was undone. */
  private sendLastSave(
    { save, replaces }: LastUpload,
    when: string | undefined,
    opened: string,
    id: string,
  ): Promise<Outgoing> {
    const filing = this.fileDraft(save, replaces);
    const handing = { closes: closesAfterPress(Date.parse(opened), when), isUndone: false, filing };
    const sent = (async () => {
      const filed = await filing;
      if (handing.isUndone) {
        await this.keepFiled(filed);
        throw new Error('The send was undone.');
      }
      // Scheduled before the save owes its sync, so the sync never finds the draft unsent.
      const outgoing = this.sending.send(
        { draft: filed.saved, ...filed.addressing },
        new Date().toISOString(),
        when,
        opened,
        id,
      );
      await this.keepFiled(filed);
      await this.wakeBy(Date.parse(outgoing.sendAt));
      return this.placed(outgoing);
    })().finally(() => this.handing.delete(id));
    this.handing.set(id, Object.assign(handing, { sent }));
    return sent;
  }

  /**
   * Writes a draft as mail and files it in Drafts, in place of the version before it, with what a
   * send of it needs to know. Everything it refuses, it refuses before the server is asked.
   */
  private async fileDraft(draft: DraftUpload, replaces?: MessageRef): Promise<FiledDraft> {
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
    const known = checked.inReplyTo && this.known(checked.inReplyTo);
    if (checked.inReplyTo && !known && !older) {
      throw new Error('The message this replies to is gone.');
    }
    const parent = known || (older && (await this.answeredBy(older)));
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
    const messageId = `<${crypto.randomUUID()}@${account.address.split('@')[1]}>`;
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
      { date: new Date().toISOString(), messageId, boundary: crypto.randomUUID() },
    );
    const raw = new TextEncoder().encode(writeMime(message));
    const saved = await (await this.provider(account.id)).saveDraft(raw);
    this.drafts.add(refKeyOf(saved));
    const replacing = older && !sameRef(older, saved) ? older : undefined;
    if (replacing) {
      // The member waits only for the new version. The old one is owed a discard before anything
      // else is awaited, and the next wake makes it before its sync, and lets its bytes go, so the
      // cache keeps only the newest draft's.
      this.replaced.owe(replacing);
      this.drafts.delete(refKeyOf(replacing));
      this.store.oweBody(replacing);
      this.sending.release(replacing);
    }
    const addressing = { messageId, to: [...checked.to, ...checked.cc], subject: checked.subject };
    return { saved, raw, ...(replacing ? { replacing } : {}), addressing };
  }

  /** Keeps a filed draft's bytes for the composer, and owes the sync that folds it in. */
  private async keepFiled({ saved, raw, replacing }: FiledDraft): Promise<void> {
    // The composer reads the draft back at once, and the server's copy would wait behind the sync
    // this save owes. Once the draft is filed, a failure here costs only that wait, so it never
    // fails the save, which a retry would file again.
    await this.env.BODIES.put(this.bodyKey(saved), raw).catch(report);
    // A discard owes its folder's sync, so no sync this save asks for finds both versions.
    await this.owe(() => {
      if (replacing?.path !== saved.path) {
        this.queue.folder({ account: saved.account, path: saved.path });
      }
    });
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

  // Folder commands judge a change by the server's own listing, not the index's, which a change a
  // moment ago may not have reached yet.

  async createFolder(folder: FolderRef): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    const provider = await this.provider(account);
    const problem = createProblem(path, await provider.folders());
    if (problem) throw new Error(problem);
    await provider.createFolder(path);
    await this.owe(() => this.queue.check(account));
  }

  async renameFolder(folder: FolderRef, to: string): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    const renamed = input.folderOf({ account, path: to }).path;
    const provider = await this.provider(account);
    const listed = await provider.folders();
    const current = listed.find((each) => each.path === path);
    if (!current) throw new Error('There is no such folder.');
    const problem = renameProblem(current, renamed, listed);
    if (problem) throw new Error(problem);
    if (renamed === path) return;
    await provider.renameFolder(path, renamed);
    // The folders inside go along, and so do the messages the index holds in them all, under the
    // paths it holds them at, which an earlier rename it hasn't listed yet may have changed since.
    this.queue.renamed(
      account,
      [current, ...inside(current, listed)].map(({ path: at }) => ({
        from: this.queue.heldAt(account, at),
        to: `${renamed}${at.slice(path.length)}`,
      })),
    );
    await this.owe(() => this.queue.check(account));
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

  async deleteFolder(folder: FolderRef): Promise<void> {
    const { account, path } = this.ownFolder(folder);
    const provider = await this.provider(account);
    const listed = await provider.folders();
    const current = listed.find((each) => each.path === path);
    // Gone already, as when another device deleted it first.
    if (!current) return;
    const problem = deleteProblem(current, listed);
    if (problem) throw new Error(problem);
    await provider.deleteFolder(path);
    await this.owe(() => this.queue.check(account));
  }

  // A message's bytes, for the Worker's routes. Null means the message or part is gone.

  /** A verified sender's picture, from the Avatar cache, by the key a read named it with. */
  avatar(key: string): Promise<Picture | null> {
    this.noteOpened();
    return Promise.resolve(this.avatars.picture(key) ?? null);
  }

  async source(ref: MessageRef): Promise<ReadableStream<Uint8Array> | null> {
    this.noteOpened();
    const bytes = await this.bytes(input.refOf(ref));
    return bytes && new Blob([bytes]).stream();
  }

  async part(
    ref: MessageRef,
    attachmentId: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; type: string; name: string } | null> {
    this.noteOpened();
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
    await this.pollSignIns();
    const accounts = this.book.all();
    if (accounts.length === 0) {
      const signInAt = this.signInWake();
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
    const checking = this.notifying.isAnyNotified() ? NOTIFYING_CHECKING_MS : CHECKING_MS;
    // A visitor's Mailroom checks only while they have it open, or as it first fills, and otherwise
    // sleeps until its erase.
    const isChecking = open || !this.isVisitors || this.checkedAt === 0;
    // If this wake ends early, as an eviction would end it, the next one is already set.
    const poll = open
      ? now + WATCHING_MS
      : isChecking
        ? now + checking
        : erasesAt(this.openedAt, this.windDown);
    await this.ctx.storage.setAlarm(
      Math.min(poll, this.sending.nextWake() ?? poll, this.signInWake() ?? poll),
    );
    // A send that is due goes before sync, which can wait.
    await this.sending.run(() => new Date().toISOString());
    // And so do the drafts newer versions replaced, so sync finds only the newest.
    const failing = await this.discardReplaced();
    // Timed from the wake's start, as the next alarm is, so the wake it sets always checks.
    if (isChecking && now - this.checkedAt >= checking - ALARM_SLACK_MS) this.checkAll(now);
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
    const isOwingDiscards = this.replaced.owed().some(({ account }) => !failing.has(account));
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
    } else await this.ctx.storage.setAlarm(Math.min(poll, sendAt, this.signInWake() ?? poll));
    return landed;
  }

  /**
   * Discards the drafts newer versions replaced, longest owed first, and owes each one's folder the
   * sync its save left to this. An account whose server fails keeps its others owed for the next
   * check, rather than each waiting out the same server. Returns the accounts whose servers failed.
   */
  private async discardReplaced(): Promise<Set<AccountId>> {
    const failing = new Set<AccountId>();
    for (const draft of this.replaced.owed()) {
      if (!failing.has(draft.account)) {
        try {
          await (await this.provider(draft.account)).discardDraft(draft);
          this.replaced.discarded(draft);
        } catch (error) {
          report(error);
          failing.add(draft.account);
        }
      }
      this.queue.folder({ account: draft.account, path: draft.path });
    }
    return failing;
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
      movedIn: (ref) => this.movedIn.delete(refKeyOf(ref)),
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
    this.movedIn.add(refKeyOf(ref));
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
          const demo = demoServer(account, mailbox, (next) => this.book.saveDemo(account, next), {
            filesSent: this.demo?.hostFilesSent,
          });
          this.demoServers.set(account, demo);
          return demo.provider;
        }
        if (!connection) throw new Error('There is no such account.');
        const signers = this.signersOf(account);
        if (deviceOf(this.book.get(account)?.account.preset)) {
          const accessToken = () => this.accessToken(account);
          return imapOver(await this.imapCode(), account, connection, { accessToken }, signers);
        }
        const sealed = this.book.sealed(account);
        if (!sealed) throw new Error('There is no such account.');
        const pass = await open(await this.memberKey(), sealed, account);
        return imapOver(await this.imapCode(), account, connection, { pass }, signers);
      })().then((made) => this.reached(made));
      this.providers.set(account, provider);
      provider.catch(() => this.providers.delete(account));
    }
    return provider;
  }

  /** The names whose Authentication-Results an account's mail is verified by. */
  private signersOf(account: AccountId): readonly string[] {
    const connection = this.book.get(account)?.connection;
    if (!connection) return [];
    if (connection.provider === 'demo') return DEMO_SIGNERS;
    return authServersFor(connection.imap.host, this.env.AUTH_SERVERS_STAND_IN);
  }

  // Signing in at a vendor

  /** The preset's sign-in, and the operator's app at its vendor, if this deployment has one. */
  private vendor(
    preset: PresetName | undefined,
  ): { signIn: DeviceSignIn; client: Client } | undefined {
    const device = preset && this.preset(preset).device;
    if (this.demo || !preset || !device || !(preset in APPS)) return undefined;
    const id = this.env[APPS[preset as SignInPreset].id];
    return id ? { signIn: device, client: { id } } : undefined;
  }

  /** A preset, with a test's stand-ins for its vendor when the test gave them. */
  protected preset(name: PresetName): Preset {
    const app = name in APPS ? APPS[name as SignInPreset] : undefined;
    return withStandIn(PRESETS[name], app && this.env[app.standIn]);
  }

  /** A request to a vendor, and its answer, within the vendor's patience. */
  private async ask(request: VendorRequest): Promise<Answer> {
    const response = await fetch(request.url, {
      method: 'POST',
      body: request.form,
      signal: AbortSignal.timeout(VENDOR_PATIENCE_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  /** When the next waiting sign-in needs a wake. */
  private signInWake(): number | undefined {
    return signing.nextWake(this.underWay.all(Date.now()));
  }

  /** Polls each sign-in whose interval has passed, and stops each whose code has expired. */
  private async pollSignIns() {
    for (const pending of this.underWay.all(Date.now())) {
      const need = signing.due(pending, Date.now());
      if (need === 'expire') this.movedOn(signing.expired(pending, Date.now()));
      else if (need === 'poll') await this.pollSignIn(pending).catch(report);
    }
  }

  private async pollSignIn(pending: signing.Pending) {
    const vendor = this.vendor(this.presetOf(pending));
    const sealed = this.underWay.sealed(pending.address);
    if (!vendor || !sealed) {
      this.movedOn(signing.refused(pending, notSetUp(this.presetOf(pending)), Date.now()));
      return;
    }
    const deviceCode = await open(await this.memberKey(), sealed, deviceCodeOf(pending.address));
    const { signIn, client } = vendor;
    let result: Polled;
    try {
      const answer = await this.ask(pollRequest(signIn, client, deviceCode));
      result = polled(signIn, answer, pending.interval, Date.now());
    } catch (error) {
      // A vendor out of reach is asked again after the interval, until the code expires.
      report(error);
      result = { pending: pending.interval };
    }
    const next = signing.polled(pending, result, Date.now());
    this.movedOn(next, next.state !== pending.state);
    if ('granted' in result) await this.finishSignIn(next, result.granted, signIn);
  }

  /** The preset a sign-in is for: the new account's, or that of the account signing in again. */
  private presetOf(pending: signing.Pending): PresetName | undefined {
    return 'account' in pending.to
      ? this.book.get(pending.to.account)?.account.preset
      : pending.to.preset;
  }

  /** Stores where a sign-in moved on to, and tells devices when they'd see a change. */
  private movedOn(pending: signing.Pending, seen = true) {
    this.underWay.update(pending);
    if (seen) this.hint({ changed: 'accounts' });
  }

  /**
   * Finishes a sign-in the vendor approved: signs in to both hosts with the token first, as a
   * password is checked, then adds the account or reconnects the one signing in again. If either
   * host refuses, the tokens go and only the reason stays.
   */
  private async finishSignIn(pending: signing.Pending, tokens: Tokens, signIn: DeviceSignIn) {
    const stop = (reason: string) => this.movedOn(signing.refused(pending, reason, Date.now()));
    const { address } = pending;
    const held = 'account' in pending.to ? this.book.get(pending.to.account) : undefined;
    if ('account' in pending.to && held?.connection.provider !== 'imap') {
      return stop('That account was removed before the sign-in finished.');
    }
    const id = held?.account.id ?? crypto.randomUUID();
    const connection =
      held?.connection.provider === 'imap' ? held.connection : this.connectionOf(pending);
    const accessToken = () => Promise.resolve(tokens.access);
    try {
      const { code, network } = await this.imapCode();
      await code.checkSignIn(imapAccount(id, connection, { accessToken }), network);
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      return stop(signIn.whenRefused ? `${said} ${signIn.whenRefused}` : said);
    }
    const sealed = await seal(await this.memberKey(), tokens.refresh, id);
    if (held) {
      await this.disconnect(id);
      this.book.reseal(id, sealed);
      this.tokens.set(id, tokens);
      this.setStatus(id, 'syncing');
    } else {
      if (this.book.all().some((account) => sameAddress(account.address, address))) {
        return stop(`${address} is already connected.`);
      }
      const { name, fromName, preset } = pending.to as signing.NewAccount;
      this.book.add(
        { id, name, address, ...(fromName ? { fromName } : {}), provider: 'imap', preset },
        connection,
        { sealed },
      );
      this.tokens.set(id, tokens);
    }
    this.underWay.finish(pending);
    this.hint({ changed: 'accounts' });
    await this.owe(() => this.queue.check(id));
  }

  /** How a new account is reached: its preset's hosts, or a test's stand-ins for them. */
  private connectionOf(pending: signing.Pending) {
    const { preset } = pending.to as signing.NewAccount;
    const { imap, smtp } = this.preset(preset);
    return connectionOf({ address: pending.address, preset, imap, smtp });
  }

  /** An access token for an account that signs in at its vendor: the one held, or a fresh one. */
  private async accessToken(account: AccountId): Promise<string> {
    const held = this.tokens.get(account);
    if (held && isFresh(held, Date.now())) return held.access;
    let refreshing = this.refreshing.get(account);
    if (!refreshing) {
      refreshing = this.refresh(account).finally(() => this.refreshing.delete(account));
      this.refreshing.set(account, refreshing);
    }
    return (await refreshing).access;
  }

  /**
   * A new access token from the account's refresh token, at the accounts server it signed in at.
   * A refresh token the vendor replaces is stored before the new access token is used. One the
   * vendor refuses for good leaves the account waiting for its member, and nothing asks again.
   */
  private async refresh(account: AccountId): Promise<Tokens> {
    const held = this.book.get(account);
    if (!held) throw new Error('There is no such account.');
    if (held.account.status === 'needs-sign-in') throw new Error(lapsed(held.account));
    const vendor = this.vendor(held.account.preset);
    const sealed = this.book.sealed(account);
    if (!vendor || !sealed) throw new Error(notSetUp(held.account.preset));
    const key = await this.memberKey();
    const kept = await open(key, sealed, account);
    const answer = await this.ask(refreshRequest(vendor.signIn, vendor.client, kept));
    const result = refreshed(vendor.signIn, answer, kept, Date.now());
    if ('lapsed' in result) {
      report(result.lapsed);
      this.tokens.delete(account);
      this.unwatch(account);
      this.setStatus(account, 'needs-sign-in');
      throw new Error(lapsed(held.account));
    }
    if ('failed' in result) throw new Error(result.failed);
    if (result.granted.refresh !== kept) {
      this.book.reseal(account, await seal(key, result.granted.refresh, account));
    }
    this.tokens.set(account, result.granted);
    return result.granted;
  }

  /** Forgets what an account owes, so a step of it under way lands nothing, and closes its provider. */
  private async disconnect(account: AccountId) {
    this.queue.forget(account);
    this.unwatch(account);
    const provider = this.providers.get(account);
    this.providers.delete(account);
    this.demoServers.delete(account);
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

  /**
   * A message's raw bytes: from the cache, or from the server once and kept from then on, while
   * the index holds the message. A draft this Mailroom saved is kept as it wrote it. A body whose
   * message leaves the index, or that the index never held, goes at the next wake.
   */
  private async bytes(ref: MessageRef): Promise<Uint8Array<ArrayBuffer> | null> {
    const key = this.bodyKey(ref);
    const cached = await this.env.BODIES.get(key);
    if (cached) return new Uint8Array(await cached.arrayBuffer());
    if (!this.known(ref) && !this.drafts.has(refKeyOf(ref))) return null;
    const stream = await (await this.provider(ref.account)).body(ref);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    await this.env.BODIES.put(key, bytes);
    // A draft just saved is indexed by the sync its save owes.
    if (!this.store.reads.message(ref) && !this.drafts.has(refKeyOf(ref))) this.store.oweBody(ref);
    return bytes;
  }

  private bodyKey(ref: MessageRef) {
    return `${this.member}/${ref.account}/${encodeURIComponent(ref.path)}/${ref.uidValidity}/${ref.uid}`;
  }

  /** The message a key in the cache keeps the body of, or nothing for a key of another shape. */
  private bodyRef(key: string): MessageRef | undefined {
    const prefix = `${this.member}/`;
    if (!key.startsWith(prefix)) return undefined;
    const [account, path, uidValidity = '', uid = '', ...more] = key
      .slice(prefix.length)
      .split('/');
    const isNumber = (part: string) => /^\d+$/.test(part);
    if (!account || path === undefined || more.length || !isNumber(uidValidity) || !isNumber(uid))
      return undefined;
    try {
      return {
        account,
        path: decodeURIComponent(path),
        uidValidity: Number(uidValidity),
        uid: Number(uid),
      };
    } catch {
      // Not a path `encodeURIComponent` wrote.
      return undefined;
    }
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

  /**
   * What a draft answers, by its own In-Reply-To and References, as a parent to thread a save to.
   * Nothing for a message that isn't in Drafts, which no save replaces, or a draft that answers
   * nothing. A draft that can't be read any more leaves its threading behind, never the save.
   */
  private async answeredBy(
    draft: MessageRef,
  ): Promise<Pick<Envelope, 'messageId' | 'references'> | undefined> {
    const drafts = this.store.folders(draft.account).find((folder) => folder.role === 'drafts');
    if (draft.path !== drafts?.path) return undefined;
    const bytes = await this.bytes(draft).catch(() => null);
    if (!bytes) return undefined;
    const { references, inReplyTo } = await PostalMime.parse(bytes);
    const thread = referencesOf(references, inReplyTo);
    const parent = thread.at(-1);
    return parent === undefined
      ? undefined
      : { messageId: parent, references: thread.slice(0, -1) };
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

  /**
   * Deletes the cached bodies owed a delete, a bucket's batch at a time, and clears what was owed
   * once each batch is gone, so a wake that ends midway leaves the rest, and the batch it was
   * deleting, for the next. Returns whether more are owed than one wake lets go.
   */
  protected async letBodiesGo(): Promise<boolean> {
    for (let gone = 0; gone < BODIES_LET_GO.wake; gone += BODIES_LET_GO.delete) {
      const refs = this.store.owedBodies(BODIES_LET_GO.delete);
      if (refs.length === 0) return false;
      await this.env.BODIES.delete(refs.map((ref) => this.bodyKey(ref)));
      this.store.bodiesLetGo(refs);
    }
    return this.store.owedBodies(1).length > 0;
  }

  /**
   * Sweeps the cache once, as a version asks after a release that kept each body after its message
   * left: a page of the bucket at a time, it lets go every body whose message the index doesn't
   * hold, unless it is a draft just saved, and notes the last key it listed, so a wake cut short or
   * a restart goes on from there. Returns whether more is left than one wake lists.
   */
  protected async sweepBodies(pages = BODIES_LET_GO): Promise<boolean> {
    for (let listed = 0; listed < pages.wake; listed += pages.delete) {
      const [sweep] = this.sql.all<{ after: string | null }>(`SELECT after FROM body_sweep`);
      if (!sweep) return false;
      const page = await this.env.BODIES.list({
        prefix: `${this.member}/`,
        limit: pages.delete,
        ...(sweep.after === null ? {} : { startAfter: sweep.after }),
      });
      const strays = page.objects.flatMap(({ key }) => {
        const ref = this.bodyRef(key);
        const isKept = !ref || this.store.reads.message(ref) || this.drafts.has(refKeyOf(ref));
        return isKept ? [] : [key];
      });
      if (strays.length) await this.env.BODIES.delete(strays);
      const last = page.objects.at(-1)?.key;
      if (!page.truncated) this.sql.run(`DELETE FROM body_sweep`);
      else if (last) this.sql.run(`UPDATE body_sweep SET after = ?`, last);
    }
    return this.sql.all(`SELECT 1 FROM body_sweep`).length > 0;
  }

  // The member's own accounts and folders

  /** The messages a command names: those given, or those of a bundle that `bundled` picks. */
  private refsIn(
    messages: MessageRef[] | BundleScope,
    bundled: (scope: BundleScope) => readonly MessageRef[],
  ): MessageRef[] {
    const checked = input.messagesOf(messages);
    if (Array.isArray(checked)) return checked;
    return bundled(checked).map(({ account, path, uidValidity, uid }) => ({
      account,
      path,
      uidValidity,
      uid,
    }));
  }

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

/** What a browser may ask, and nothing else the Mailroom answers to. */
const CALLABLE: ReadonlySet<string> = new Set([...QUERIES, ...COMMANDS]);

/**
 * Where the time of the browser's call running now went on its mail servers, by part. Calls
 * interleave at each wait, so each keeps its own, and the wake's work, which no call runs, none.
 */
const spending = new AsyncLocalStorage<Map<ImapPart, number>>();
const IMAP_PARTS: readonly ImapPart[] = ['connect', 'imap', 'folder'];

/** The IMAP provider for an account, over workerd's sockets. */
function imapOver(
  { code, network }: ImapCode,
  account: AccountId,
  connection: Extract<Connection, { provider: 'imap' }>,
  secret: Secret,
  authServers: readonly string[],
): MailProvider {
  return code.imapProvider({ ...imapAccount(account, connection, secret), authServers }, network);
}

/** A password, or what gives each connection an access token from the account's vendor. */
/** What Send may carry in place of a draft: the message's last save. */
type LastUpload = { save: DraftUpload; replaces?: MessageRef };

/** A draft just filed, with what a send of it names. */
type FiledDraft = {
  saved: MessageRef;
  raw: Uint8Array;
  replacing?: MessageRef;
  addressing: Pick<Outgoing, 'messageId' | 'to' | 'subject'>;
};

/** A send whose last save is being filed. Undo before its window closes keeps it as a draft. */
type Handing = {
  closes: number;
  isUndone: boolean;
  filing: Promise<FiledDraft>;
  sent: Promise<Outgoing>;
};

type Secret = { pass: string } | { accessToken: () => Promise<string> };

function imapAccount(
  account: AccountId,
  connection: Extract<Connection, { provider: 'imap' }>,
  secret: Secret,
): ImapAccount {
  return {
    account,
    imap: connection.imap,
    smtp: connection.smtp,
    auth: { user: connection.user, ...secret },
    filesSent: connection.filesSent,
  };
}

/** A sign-in as a browser sees it, without what only the Mailroom needs. */
function signInOf(pending: signing.Pending): SignIn {
  const seen = {
    address: pending.address,
    ...('account' in pending.to ? { account: pending.to.account } : {}),
    code: pending.code,
    link: pending.link,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
  return pending.state === 'refused'
    ? { ...seen, state: 'refused', reason: pending.reason }
    : { ...seen, state: pending.state };
}

/**
 * What a device code is sealed to: its address, apart from every account's id, so it can never be
 * opened as an account's secret.
 */
const deviceCodeOf = (address: string) => `sign-in:${address.toLowerCase()}`;

/** How a preset's accounts sign in at its vendor, if they do instead of with a password. */
function deviceOf(preset: PresetName | undefined): DeviceSignIn | undefined {
  const held: Preset | undefined = preset && PRESETS[preset];
  return held?.device;
}

/** Why a preset can't sign in here. */
function notSetUp(preset: PresetName | undefined): string {
  const device = deviceOf(preset);
  if (!preset || !device || !(preset in APPS)) return 'That account doesn’t sign in at its vendor.';
  const { id } = APPS[preset as SignInPreset];
  return `${device.vendor} sign-in isn’t set up on this Trail Mix. The operator registers an app with ${device.vendor} and sets ${id}.`;
}

const sameAddress = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();

/** What a member reads when an account's sign-in has lapsed. */
const lapsed = (account: Account) => `Sign in to ${account.name} again.`;

/**
 * The IMAP provider's code, and how the Mailroom reaches hosts with it: workerd's STARTTLS works
 * only on its own sockets. Both load when this isolate first needs them, so one that never reaches
 * a mail server, as every demo Mailroom and the Worker's own isolates don't, never runs the mail
 * libraries. A load that fails is tried again the next time.
 */
type ImapCode = { code: Awaited<ReturnType<typeof imap>>; network: Network };

let imapLoaded: Promise<ImapCode> | undefined;

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
          const spent = spending.getStore();
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

const sizeOf = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength;

/** When a signed-in device last asked this Mailroom for something, as storage holds it. */
function openedAtIn(sql: Sql): number | undefined {
  const [row] = sql.all<{ at: number }>(`SELECT at FROM opened`);
  return row?.at;
}

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
