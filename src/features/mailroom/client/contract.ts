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
  conversations(view: View, after?: PageCursor): Promise<Page>;
  conversation(id: ConversationId): Promise<Message[]>;
  body(ref: MessageRef): Promise<Body>;
  outbox(): Promise<Outgoing[]>;
}

export interface Commands {
  /** The only call that carries a secret. */
  addAccount(setup: AccountSetup): Promise<Account>;
  updateAccount(
    id: AccountId,
    change: Partial<Pick<Account, 'name' | 'stamp' | 'signature'>>,
  ): Promise<void>;
  removeAccount(id: AccountId): Promise<void>;
  /** From now on, this sender's remote images load. */
  allowImages(account: AccountId, sender: string): Promise<void>;
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
  /** Returns the draft, untouched. */
  cancelSend(id: string): Promise<MessageRef>;
  createFolder(folder: FolderRef): Promise<void>;
  renameFolder(folder: FolderRef, to: string): Promise<void>;
  deleteFolder(folder: FolderRef): Promise<void>;
}

/** Where the next page of a list starts. Only the Mailroom reads it. */
export type PageCursor = string;

/** One page of a list, newest first, and where the next one starts if there is more. */
export type Page = { items: ConversationSummary[]; next?: PageCursor };

/**
 * What connecting an account takes: nothing for the demo mailbox, and a password for an IMAP host.
 * Outlook takes no password: the Mailroom starts Microsoft's device-code sign-in instead.
 */
export type AccountSetup =
  | { provider: 'demo' }
  | {
      provider: 'imap';
      name: string;
      address: string;
      /** Supplies hosts, ports and quirks. Without one, both endpoints are required. */
      preset?: 'zoho';
      imap?: Endpoint;
      smtp?: Endpoint;
      /** The only secret. The Mailroom encrypts it before anything is stored. */
      password: string;
    }
  | { provider: 'imap'; name: string; address: string; preset: 'outlook' };

export type Endpoint = { host: string; port: number; secure: boolean };

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
   * New bytes travel once. After that, an attachment is named by the message that holds it: the
   * draft this one replaces, or the message being forwarded.
   */
  attachments: (File | { in: MessageRef; id: string })[];
};

/** The Mailroom as the Worker reaches it: its queries and commands, and the hint socket by `fetch`. */
export type Mailroom = Queries & Commands & { fetch(request: Request): Promise<Response> };

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
] as const satisfies readonly (keyof Queries)[];

export const COMMANDS = [
  'addAccount',
  'updateAccount',
  'removeAccount',
  'allowImages',
  'eraseEverything',
  'setFlags',
  'move',
  'saveDraft',
  'send',
  'cancelSend',
  'createFolder',
  'renameFolder',
  'deleteFolder',
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

const isOneOf = <Name extends string>(names: readonly Name[], value: unknown): value is Name =>
  (names as readonly unknown[]).includes(value);
