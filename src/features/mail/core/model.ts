/**
 * The mail vocabulary. Every layer uses these nouns with these names: the index, the contracts and
 * the interface. A message's identity is the mail server's own, so Trail Mix mints no message ids.
 */

export type AccountId = string;

/** A folder on the mail server: its account and its full path, such as "INBOX" or "Projects/Toy Box". */
export type FolderRef = { account: AccountId; path: string };

/** A message is its account, folder path, UIDVALIDITY and UID. */
export type MessageRef = FolderRef & { uidValidity: number; uid: number };

export type ConversationId = string;

/** Folders are recognized by role, never by name. */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'junk';

export type Flags = { seen: boolean; flagged: boolean; answered: boolean; draft: boolean };

export type Address = { name?: string; email: string };

/** An account's color, which marks its rows in the unified views. Assigned in this order. */
export type StampColor = 'vermilion' | 'teal' | 'violet' | 'amber' | 'green' | 'slate';

/** One mailbox a member has connected. */
export type Account = {
  id: AccountId;
  /** Shown in the sidebar, for example "Personal". */
  name: string;
  address: string;
  provider: 'imap' | 'demo';
  /** Hosts, ports, sign-in method and quirks. */
  preset?: 'zoho' | 'outlook';
  stamp: StampColor;
  /** Markdown. */
  signature?: string;
  /** Senders whose remote images load, always through the Worker's proxy. */
  allowImagesFrom: string[];
  status: 'ready' | 'syncing' | 'needs-sign-in' | 'error';
};

export type Folder = FolderRef & {
  name: string;
  /** The path of the folder this one sits in, or nothing at the top of the tree. */
  parent?: string;
  role?: FolderRole;
  unread: number;
  total: number;
};

/** What a provider reports about a message: everything a list or a search needs, and no body. */
export type Envelope = MessageRef & {
  /** In `<id@host>` form, or empty when the message has none. */
  messageId: string;
  /** In-Reply-To and References, in `<id@host>` form, the thread's first message first. */
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  /** ISO 8601. */
  date: string;
  /** The first 200 characters of text. */
  preview: string;
  flags: Flags;
  hasAttachments: boolean;
  /** List-Id and List-Unsubscribe. */
  list?: { id: string; unsubscribe?: string };
};

/**
 * What the index holds for one message. The fold assigns its conversation, linking one account's
 * Inbox, Sent, Archive and Drafts. Any other folder links only within itself.
 */
export type Message = Envelope & { conversation: ConversationId };

/** One row of a list. Rows are one fixed height, so a list virtualizes without measuring. */
export type ConversationSummary = {
  id: ConversationId;
  account: AccountId;
  /** The latest message's. */
  subject: string;
  /** Newest first. */
  senders: Address[];
  /** The latest message's. */
  preview: string;
  /** The latest message's. */
  date: string;
  count: number;
  unread: number;
  /** Whether any message is flagged. */
  flagged: boolean;
  /** Whether any message has attachments. */
  hasAttachments: boolean;
};

/** The content of one message, fetched on first open. It never changes for a `MessageRef`. */
export type Body = {
  /** Exactly as received. The browser sanitizes and sandboxes it. */
  html?: string;
  text?: string;
  attachments: { id: string; name: string; type: string; size: number; contentId?: string }[];
  headers: [name: string, value: string][];
};

/** What a list shows: one folder, a unified view across every account, or a search. */
export type View =
  | { in: 'folder'; folder: FolderRef }
  | { in: 'inbox' | 'flagged' | 'drafts' | 'outbox' }
  | { in: 'search'; text: string; fullText?: boolean };

/**
 * A message on the WebSocket that names what changed, so the browser knows what to refetch. Hints
 * arrive at most once and in no guaranteed order.
 */
export type Hint =
  | { changed: 'accounts' }
  | { changed: 'folders'; account: AccountId }
  | { changed: 'conversations'; folder: FolderRef }
  | { changed: 'outbox' };

/**
 * An Outbox entry. A draft is a message in a folder whose role is `drafts`, and the Outbox is a
 * schedule of drafts to send.
 */
export type Outgoing = {
  id: string;
  /** Stays in Drafts until the mail server accepts the send. */
  draft: MessageRef;
  /** The draft's, so a missing draft counts as sent only if Sent holds it. */
  messageId: string;
  /** When the next attempt is due: the member's chosen time, then each automatic retry's. */
  sendAt: string;
  /** `accepted`: the host took it, and only filing its copy in Sent remains. */
  state: 'waiting' | 'sending' | 'accepted' | 'failed';
  /** The attempts at the current step that failed. */
  attempts: number;
  /** Why the last attempt failed. */
  error?: string;
};
