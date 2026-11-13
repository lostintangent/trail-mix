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
  /** The name recipients see beside the address, for example "Ada Lovelace". */
  fromName?: string;
  provider: 'imap' | 'demo';
  /** Hosts, ports, sign-in method and quirks. */
  preset?: 'zoho' | 'outlook';
  stamp: StampColor;
  /** Markdown. */
  signature?: string;
  /** Senders whose remote images load, always through the Worker's proxy. */
  allowImagesFrom: string[];
  /** Senders whose HTML mail shows on light paper in the dark theme, as they designed it. */
  lightPaperFrom: string[];
  status: 'ready' | 'syncing' | 'needs-sign-in' | 'error';
};

export type Folder = FolderRef & {
  name: string;
  /** The path of the folder this one sits in, or nothing at the top of the tree. */
  parent?: string;
  /**
   * The character between the names in this folder's path, as the server lists it, so a folder
   * inside this one is at its path, the delimiter, then its name. Absent where folders can't nest.
   */
  delimiter?: string;
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
  /** Whether the account's own mail server found DMARC passing for the domain in From. */
  verified: boolean;
};

/**
 * What the index holds for one message. The fold assigns its conversation, linking one account's
 * Inbox, Sent, Archive and Drafts. Any other folder links only within itself.
 */
export type Message = Envelope & {
  conversation: ConversationId;
  /**
   * The key `/avatars/<key>` serves its sender's picture under, when the message is verified and
   * the Avatar cache holds one. Filled on each read.
   */
  avatar?: string;
};

/**
 * One row of a list. Rows are one fixed height, so a list virtualizes without measuring. In a
 * search, subject, preview and date are the newest matching message's, and rank the row.
 */
export type ConversationSummary = {
  id: ConversationId;
  account: AccountId;
  /** The latest message's. */
  subject: string;
  /** Newest first. */
  senders: Address[];
  /** The latest message's To and Cc, which a row names when only the member wrote. */
  recipients: Address[];
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
  /**
   * The picture of its newest sender other than the member, as a Message names it, or of its first
   * recipient other than the member when only they wrote.
   */
  avatar?: string;
  /** What it is about on GitHub, when every message in its Inbox is a notification of one thread. */
  github?: GitHubThread;
};

/** An account and a GitHub repository, as `<account>:<owner/repo>`, each part URI-encoded. */
export type BundleId = string;

/** What a GitHub notification is about. */
export type GitHubKind = 'pull' | 'issue' | 'discussion' | 'run';

/** Why GitHub notified the member, as the Cc it adds says. */
export type GitHubReason =
  | 'assign'
  | 'author'
  | 'ci_activity'
  | 'comment'
  | 'manual'
  | 'mention'
  | 'push'
  | 'review_requested'
  | 'security_alert'
  | 'state_change'
  | 'subscribed'
  | 'team_mention'
  | 'your_activity';

/**
 * The pull request, issue, discussion or workflow run a conversation of verified GitHub
 * notifications is about, as its messages tell it.
 */
export type GitHubThread = {
  /** `owner/repo`, as GitHub writes it. */
  repository: string;
  kind: GitHubKind;
  /** A pull request's, issue's or discussion's number, or a run's id where its mail names one. */
  number?: number;
  /** A run's commit, abbreviated as its subject names it. */
  commit?: string;
  /** The newest message's subject, without the repository and number. */
  title: string;
  /** What the newest message that changed it said: merged or closed. Reopened is neither. */
  state?: 'merged' | 'closed';
  /** How the newest run or checks it reports on ended. */
  outcome?: 'passed' | 'failed' | 'cancelled';
  /** Every reason its messages give, those that ask something of the member first, then newest first. */
  reasons: GitHubReason[];
};

/**
 * One row of an Inbox view that stands for an account's GitHub notifications about one
 * repository: every conversation in its Inbox whose `github` names that repository. As tall as a
 * conversation's row, and placed by its newest message.
 */
export type BundleSummary = {
  kind: 'bundle';
  id: BundleId;
  account: AccountId;
  /** `owner/repo`, as its newest thread writes it. */
  repository: string;
  /** The newest message's. */
  date: string;
  /** Its newest thread. */
  newest: Omit<GitHubThread, 'repository' | 'reasons'>;
  /** How many conversations it holds. */
  threads: number;
  /** How many messages they hold, and how many of those are unread. */
  count: number;
  unread: number;
  /** Whether any message is flagged. */
  flagged: boolean;
  /**
   * One for each of its first threads, each its first reason: the unread ones that ask something of
   * the member first, then the rest newest first. `threads` counts the ones left out.
   */
  chips: BundleChip[];
  /** Its newest conversation's. */
  avatar?: string;
};

/** A thread as its bundle's row shows it. */
export type BundleChip = Pick<GitHubThread, 'kind' | 'state' | 'outcome'> & {
  reason?: GitHubReason;
  unread: boolean;
};

/** One row of a list: a conversation, or in an Inbox view, a bundle. */
export type ListItem = ConversationSummary | BundleSummary;

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
 * Where a member is, as the address names it: the view open, the bundle open in an Inbox view, and
 * the conversation open in either.
 */
export type Place = { view: View; bundle?: BundleId; open?: ConversationId };

/**
 * A message on the WebSocket that names what changed, so the browser knows what to refetch. Hints
 * arrive at most once and in no guaranteed order.
 */
export type Hint =
  | { changed: 'accounts' }
  | { changed: 'folders'; account: AccountId }
  | { changed: 'conversations'; folder: FolderRef }
  | { changed: 'outbox' }
  // A sender's picture came, changed or went: the lists on screen name it, or no longer do.
  | { changed: 'avatars' }
  // After an erase: nothing a device has, or kept, is the member's any more.
  | { changed: 'everything' };

/**
 * An Outbox entry. A draft is a message in a folder whose role is `drafts`, and the Outbox is a
 * schedule of drafts to send.
 */
export type Outgoing = {
  id: string;
  /** Stays in Drafts until the mail server accepts the send. */
  draft: MessageRef;
  /** The draft's To then Cc, taken when it is scheduled. A draft on its way can't change. */
  to: Address[];
  /** The draft's subject, taken when it is scheduled. */
  subject: string;
  /** The conversation the draft is in, read from the index each time, and absent until it's there. */
  conversation?: ConversationId;
  /** The draft's, so a missing draft counts as sent only if Sent holds it. */
  messageId: string;
  /** When the next attempt is due: the member's chosen time, then each automatic retry's. */
  sendAt: string;
  /** `accepted`: the host took it, and only filing its copy in Sent remains. */
  state: 'waiting' | 'sending' | 'accepted' | 'failed';
  /** When the host accepted it, so filing can tell how long it has waited for the host's copy. */
  acceptedAt?: string;
  /** The attempts at the current step that failed. */
  attempts: number;
  /** Why the last attempt failed. */
  error?: string;
};
