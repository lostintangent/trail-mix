import type {
  Account,
  AccountId,
  Address,
  Body,
  ConversationId,
  ConversationSummary,
  Flags,
  Folder,
  FolderRef,
  FolderRole,
  Message,
  MessageRef,
  Outgoing,
  View,
} from '../../mail/core/index.ts';
import type { Members } from '../../members/core/index.ts';
import type { Subscription } from '../../notifications/core/index.ts';
// Brings Start's `Register` in, so the declaration below can add to it in either program.
import type {} from '@tanstack/react-start';

/**
 * What a browser can ask its Mailroom. Queries return snapshots. Commands return once the Mailroom
 * has accepted them. Hints, on the socket, say what to refetch.
 *
 * Every method returns a promise, since the Worker reaches the Mailroom through a Durable Object
 * stub. No method takes a member: the Worker picks the Mailroom from the verified sign-in alone.
 */
export interface Queries {
  accounts(): Promise<Account[]>;
  folders(): Promise<Folder[]>;
  /**
   * A stretch of a view's list from its place `at`, with 0 the newest, and how long the list is,
   * so any stretch of it can be asked for. A search's list holds the conversations that match.
   */
  conversations(view: View, at?: number): Promise<Page>;
  conversation(id: ConversationId): Promise<Message[]>;
  body(ref: MessageRef): Promise<Body>;
  outbox(): Promise<Outgoing[]>;
  /** Sign-ins under way, and why one stopped, until its code would have expired. */
  signIns(): Promise<SignIn[]>;
  /** The presets this deployment can sign in at, which is how it's set up, not what's under way. */
  signInPresets(): Promise<SignInPreset[]>;
  /** What this device keeps, and whether the device at `endpoint` is notified. */
  thisDevice(endpoint?: string): Promise<ThisDevice>;
}

/**
 * `cache` names what an installed app keeps of this Mailroom. A new Mailroom, as an erase leaves,
 * has a new one, so a device that kept the old one's drops what it kept. `pushKey` is the public key
 * a device subscribes to notifications with, absent where notifications are off, as on previews and
 * the demo. `notified` says whether the device at the endpoint asked about is notified. `visitor`
 * is set only on a visitor's Mailroom on the public demo, which keeps both demo accounts and erases
 * itself a day after it was last opened.
 */
export type ThisDevice = { cache: string; pushKey?: string; notified: boolean; visitor?: true };

export interface Commands {
  /** The only call that carries a secret. */
  addAccount(setup: AccountSetup): Promise<Account>;
  /**
   * Starts a sign-in at the preset's vendor, for a new account or for one whose status is
   * `needs-sign-in`. The Mailroom finishes it. Starting another for the same address replaces it.
   */
  signIn(to: SignInSetup | AccountId): Promise<SignIn>;
  /** An empty `fromName` removes it, and mail is from the address alone. */
  updateAccount(
    id: AccountId,
    change: Partial<Pick<Account, 'name' | 'fromName' | 'stamp' | 'signature'>>,
  ): Promise<void>;
  removeAccount(id: AccountId): Promise<void>;
  /** From now on, this sender's remote images load. */
  allowImages(account: AccountId, sender: string): Promise<void>;
  /** This sender's HTML mail on light paper in the dark theme, as designed, or darkened again. */
  setLightPaper(account: AccountId, sender: string, on: boolean): Promise<void>;
  /** This member's accounts, index, cache and credentials. */
  eraseEverything(): Promise<void>;
  setFlags(refs: MessageRef[], change: Partial<Flags>): Promise<void>;
  /** Archive and delete are moves to a role. Undo moves each `to` back to its `from` folder. */
  move(
    refs: MessageRef[],
    to: FolderRef | FolderRole,
  ): Promise<{ from: MessageRef; to: MessageRef }[]>;
  saveDraft(draft: DraftInput, replaces?: MessageRef): Promise<MessageRef>;
  /** At now plus the undo window, unless given a time. */
  send(draft: MessageRef, at?: string): Promise<Outgoing>;
  /** Returns the draft, untouched. Refused once the send is due, unless it failed. */
  cancelSend(id: string): Promise<MessageRef>;
  /** A failed send, tried again now. */
  retrySend(id: string): Promise<Outgoing>;
  /**
   * At its parent's path, the parent's delimiter, then its name, or the name alone at the top. The
   * name follows the folder name rules, and the parent is one of the account's folders.
   */
  createFolder(folder: FolderRef): Promise<void>;
  /**
   * `to` is the folder's new path, in the same parent: a rename never moves a folder. The folders
   * inside go along. Refused for a folder with a role in it or anywhere inside it.
   */
  renameFolder(folder: FolderRef, to: string): Promise<void>;
  /**
   * The folder, its mail and every folder inside it, gone for good, once the server confirms it.
   * Refused for a folder with a role in it or anywhere inside it.
   */
  deleteFolder(folder: FolderRef): Promise<void>;
  /**
   * Notifies this device of new Inbox mail from now on. Its keys let only this deployment write to
   * it, and no query returns them.
   */
  notifyDevice(subscription: Subscription): Promise<void>;
  forgetDevice(endpoint: string): Promise<void>;
}

/**
 * One page of a list, newest first: its conversations, the place of its first, with 0 the newest,
 * and how many conversations the whole list holds.
 */
export type Page = { items: ConversationSummary[]; at: number; total: number };

/** How many conversations a page holds, but the list's last. A browser asks for pages from places this far apart. */
export const PAGE_SIZE = 50;

/** The most conversations a search as it is typed lists: its newest that match. */
export const MATCHES_LISTED = 1_000;

/**
 * What connecting an account takes: nothing for the demo mailbox, and a password for an IMAP host.
 * Outlook takes no password, and is added by `signIn` instead.
 */
export type AccountSetup =
  | { provider: 'demo' }
  | {
      provider: 'imap';
      name: string;
      address: string;
      fromName?: string;
      /**
       * Supplies quirks, and the endpoints when none are given. Endpoints come both or neither,
       * and given ones win: Zoho's server names depend on the account. Without a preset, both are
       * required.
       */
      preset?: 'zoho';
      imap?: Endpoint;
      smtp?: Endpoint;
      /** The only secret. The Mailroom encrypts it before anything is stored. */
      password: string;
    };

export type Endpoint = { host: string; port: number; secure: boolean };

/**
 * An account that signs in at its vendor instead of taking a password. The Mailroom runs the
 * preset's device-code sign-in, polls it on its alarm, and seals the refresh token in place of a
 * password. The browser sees only the code.
 */
export type SignInSetup = {
  preset: SignInPreset;
  name: string;
  address: string;
  fromName?: string;
};

/** The presets whose vendor a member can sign in at instead of giving a password. */
export type SignInPreset = 'outlook';

/**
 * A sign-in under way. Finished needs no state: the row goes, and the account appears or leaves
 * `needs-sign-in`. One that stops keeps nothing but its reason. The accounts hint names every change.
 */
export type SignIn = {
  address: string;
  /** Present when an account is signing in again. */
  account?: AccountId;
  /** What the member types at `link`. */
  code: string;
  link: string;
  /** ISO 8601. */
  expiresAt: string;
} & ({ state: 'waiting' } | { state: 'checking' } | { state: 'refused'; reason: string });

/** What the composer saves. The Mailroom writes it as MIME and files it in the account's Drafts. */
export type DraftInput = {
  /** The From. */
  account: AccountId;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Rendered to HTML and plain text. */
  markdown: string;
  /** Joins the draft to that message's conversation. */
  inReplyTo?: MessageRef;
  /**
   * New bytes travel once. After that, an attachment is named by the message that holds it, the
   * draft this one replaces or the message being forwarded, and by its `id` in that message's
   * `Body`, which a just-saved draft answers too. A pasted image carries the Content-ID
   * the Markdown shows it by as `cid:`, which the browser mints with `contentIdFor`, and stored
   * bytes keep theirs.
   */
  attachments: ({ file: File; contentId?: string } | { in: MessageRef; id: string })[];
};

/**
 * A browser's file as it reaches the Mailroom. A Durable Object takes no `File`, so the Worker reads
 * each one into bytes on the way.
 */
export type FileBytes = { name: string; type: string; content: Uint8Array };

/** A `DraftInput` as it reaches the Mailroom, with its new files read into bytes. */
export type DraftUpload = Omit<DraftInput, 'attachments'> & {
  attachments: ({ file: FileBytes; contentId?: string } | { in: MessageRef; id: string })[];
};

/**
 * The Mailroom as the Worker reaches it: its queries and commands, the hint socket by `fetch`, and
 * closing its devices, which only the operator's removal of this member asks for.
 */
export type Mailroom = Queries &
  Omit<Commands, 'saveDraft'> & {
    saveDraft(draft: DraftUpload, replaces?: MessageRef): Promise<MessageRef>;
    /**
     * Runs a query or command a browser sent, which is how the Worker asks for every one, and says
     * how long it took. `sentAt` is when the Worker sent it, by the Worker's clock.
     */
    answer(call: Call<QueryName | CommandName>, sentAt: number): Promise<Answered>;
    fetch(request: Request): Promise<Response>;
    closeDevices(): Promise<void>;
  };

/**
 * A call's answer, with how long it took in the Mailroom, for the response's Server-Timing. On
 * Cloudflare a clock stands still while code runs, so each time counts waiting, not computing.
 */
export type Answered = {
  value: unknown;
  /** From the Worker sending the call to the Mailroom starting it, by two clocks Cloudflare keeps in step. */
  reached: number;
  /** From the Mailroom starting the call to its answer. */
  ran: number;
  /** Whether the Mailroom started for this call, rather than already running. */
  cold: boolean;
};

/** One part of a request's time, for its Server-Timing header: a name, a duration, a note. */
export type Timed = { name: string; ms?: number; note?: string };

declare module '@tanstack/react-start' {
  interface Register {
    server: {
      /**
       * The Worker hands each request a way to reach its signed-in member's Mailroom, a new stub
       * each time, and nothing that names them, the Members page's side for them, which answers the operator alone, and the parts of the
       * request's time, which a call adds to and the Worker sends as Server-Timing.
       */
      requestContext: { mailroom: () => Mailroom; members: Members; timing: Timed[] };
    };
  }
}

/**
 * The names a browser may call, and nothing else. A Durable Object stub forwards any public method,
 * so these lists are the boundary between a browser and everything else the Mailroom does.
 */
export const QUERIES = [
  'accounts',
  'folders',
  'conversations',
  'conversation',
  'body',
  'outbox',
  'signIns',
  'signInPresets',
  'thisDevice',
] as const satisfies readonly (keyof Queries)[];

export const COMMANDS = [
  'addAccount',
  'signIn',
  'updateAccount',
  'removeAccount',
  'allowImages',
  'setLightPaper',
  'eraseEverything',
  'setFlags',
  'move',
  'saveDraft',
  'send',
  'cancelSend',
  'retrySend',
  'createFolder',
  'renameFolder',
  'deleteFolder',
  'notifyDevice',
  'forgetDevice',
] as const satisfies readonly (keyof Commands)[];

export type QueryName = (typeof QUERIES)[number];
export type CommandName = (typeof COMMANDS)[number];

// Each list names every method of its interface, so a new method can't be left uncallable.
true satisfies [Exclude<keyof Queries, QueryName>] extends [never] ? true : never;
true satisfies [Exclude<keyof Commands, CommandName>] extends [never] ? true : never;

/** A call a browser sends: the name of a query or command, and its arguments in order. */
export type Call<Name extends string> = { name: Name; args: unknown[] };

/**
 * The call a browser sent, if it names a method on the given list. Anything else is refused before
 * it reaches the Mailroom. The Mailroom checks the arguments, as it does any input.
 */
export function readCall<Name extends string>(names: readonly Name[], input: unknown): Call<Name> {
  if (typeof input === 'object' && input !== null && 'name' in input && 'args' in input) {
    const { name, args } = input;
    if (isOneOf(names, name) && Array.isArray(args)) return { name, args };
  }
  throw new TypeError('That isn’t something a browser can ask its Mailroom.');
}

/**
 * How a call travels from a browser. A call that carries files goes as form data, each file as a
 * part of its own and named in the call by `{ $file: n }`, so its bytes travel as they are. Any
 * other call goes as JSON.
 */
export function sendable(call: Call<string>): Call<string> | FormData {
  const files: File[] = [];
  // JSON has no undefined, and would send an optional argument left out as null.
  const given = call.args.slice(0, call.args.findLastIndex((arg) => arg !== undefined) + 1);
  const args = JSON.parse(
    JSON.stringify(given, (_key, value: unknown) =>
      value instanceof File ? { $file: files.push(value) - 1 } : value,
    ),
  ) as unknown[];
  if (files.length === 0) return call;
  const form = new FormData();
  form.set('call', JSON.stringify({ name: call.name, args }));
  files.forEach((file, n) => form.set(`file${n}`, file));
  return form;
}

/** The most bytes one call may carry in files: what a Durable Object call can hold, with room. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The call a browser sent, as `sendable` sent it, with each file read into bytes. As with
 * `readCall`, nothing off the list gets through.
 */
export async function receivedCall<Name extends string>(
  names: readonly Name[],
  input: unknown,
): Promise<Call<Name>> {
  if (!(input instanceof FormData)) return readCall(names, input);
  const sent = input.get('call');
  const call = readCall(names, typeof sent === 'string' ? (JSON.parse(sent) as unknown) : null);
  const files = new Map<number, FileBytes>();
  let total = 0;
  for (const [key, value] of input) {
    const n = /^file(\d{1,3})$/.exec(key)?.[1];
    if (n === undefined || !(value instanceof File)) continue;
    total += value.size;
    if (total > MAX_FILE_BYTES) {
      throw new TypeError(`Files on one draft can add up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    }
    const content = new Uint8Array(await value.arrayBuffer());
    files.set(Number(n), { name: value.name, type: value.type, content });
  }
  const filled = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(filled);
    if (typeof value !== 'object' || value === null) return value;
    if ('$file' in value) {
      const file = files.get(Number(value.$file));
      if (!file) throw new TypeError('That call names a file it didn’t send.');
      return file;
    }
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, filled(inner)]));
  };
  return { name: call.name, args: call.args.map(filled) };
}

const isOneOf = <Name extends string>(names: readonly Name[], value: unknown): value is Name =>
  (names as readonly unknown[]).includes(value);
