import type { Envelope, Flags, Folder, MessageRef, SyncEvent } from '../mail/core/index.ts';

/**
 * The MailProvider contract: everything Trail Mix needs from a mail host. Adding a protocol means
 * implementing this interface and nothing else. Vendors are presets of a protocol's provider.
 *
 * A provider speaks for one account, and every ref and folder it reports names that account. The
 * mail server stays the authority: a command changes the server, the next sync reports the change,
 * and the index records it from there. Every command is safe to repeat, so a retry is always the
 * way to recover from a failure part way through.
 */
export interface MailProvider {
  /**
   * Every folder, with its role where the server marks one or its name makes it plain, and the
   * delimiter its server puts between the names in a path.
   */
  folders(): Promise<Folder[]>;

  /**
   * One bounded batch of what changed in a folder since `cursor`, newest first. Call again from the
   * returned cursor while `more`. A null cursor, or one the provider no longer recognizes, starts
   * the folder over with a `reset`, in a first batch of at most `FIRST_SYNC_BATCH` messages.
   */
  sync(folder: string, cursor: Cursor | null, window: SyncWindow): Promise<SyncBatch>;

  /** The raw message, exactly as the server stores it. It never changes for a ref. */
  body(ref: MessageRef): Promise<ReadableStream<Uint8Array>>;

  /** Sets or clears the named flags. Refs that are already gone are skipped. */
  setFlags(refs: MessageRef[], change: Partial<Flags>): Promise<void>;

  /**
   * Moves messages to another folder, and resolves with where each one landed, so a move can be
   * undone by moving each `to` back to its `from` folder. Refs that are already gone, moved or not,
   * are skipped, and so is a message whose new place cannot be known.
   */
  move(refs: MessageRef[], to: string): Promise<Moved[]>;

  /**
   * Files a draft in the account's Drafts and returns its ref. With `replaces`, the older draft is
   * removed once the new one is saved, so a crash in between leaves two drafts, never none.
   */
  saveDraft(message: Uint8Array, replaces?: MessageRef): Promise<MessageRef>;

  /**
   * Sending is two steps, each safe to repeat, and the Outbox records the host's acceptance between
   * them, so nothing after it can deliver again. `submit` hands the draft to the host, Bcc and all
   * but with no Bcc header, unless Sent already holds `messageId`, and resolves once the host has
   * accepted it: `sent` if it left now or before, `missing` if the draft is gone and Sent does not
   * hold it. A missing draft is never reported as sent. It rejects with a `SendFailure`.
   */
  submit(draft: MessageRef, messageId: string): Promise<'sent' | 'missing'>;

  /**
   * Leaves exactly one copy of a submitted draft in Sent, then removes the draft, and resolves
   * `filed`. It appends a copy unless Sent already holds `messageId`. A host that files its own copy
   * may do so a while after it accepted the message, so while `waitForHost` such a host is left to
   * it: until Sent holds its copy, the draft stays and filing resolves `unfiled`. It never submits,
   * so repeating it cannot deliver twice. With the draft already gone there is nothing left to do.
   * It rejects with a `SendFailure`.
   */
  file(draft: MessageRef, messageId: string, waitForHost: boolean): Promise<'filed' | 'unfiled'>;

  /**
   * A folder's messages whose headers or body contain `text`, searched by the server across the
   * whole folder, not only the sync window. The newest to arrive, at most `SEARCH_LIMIT`, newest
   * first. A hit is reported, never folded: the index learns of mail only through sync.
   */
  search(folder: string, text: string): Promise<Envelope[]>;

  /**
   * Calls `onChange` when the server says a folder changed, until the returned function is called.
   * Best effort: a connection can drop without notice, so the Mailroom still polls.
   */
  watch(folder: string, onChange: () => void): () => void;

  /** Creating a folder that exists, or deleting one that does not, does nothing. */
  createFolder(path: string): Promise<void>;
  /** Takes the folders inside along, as IMAP's RENAME does. */
  renameFolder(path: string, to: string): Promise<void>;
  /**
   * Deletes the folder, its mail and every folder inside it, the deepest first, as the server lists
   * them now. Resolves only once the server no longer lists any of them, and rejects with why if it
   * still does, since some servers answer a parent's delete with OK and keep the folder.
   */
  deleteFolder(path: string): Promise<void>;

  /** Ends the provider's connections. A provider is not used again after this. */
  close(): Promise<void>;
}

export type { SyncEvent };

/**
 * The most messages a folder's first batch holds when it starts over, so its newest mail shows
 * soon, and the batch that pays for a cold start does the least work.
 */
export const FIRST_SYNC_BATCH = 100;

/** How many messages one folder's search reports at most. */
export const SEARCH_LIMIT = 100;

/**
 * Why a step of sending failed. `passing` when it cannot have delivered anything and the same step
 * may well succeed later, such as no connection or an SMTP 4xx. A refusal is not passing, and
 * neither is a connection lost after the message went out, which may have delivered it.
 */
export class SendFailure extends Error {
  readonly passing: boolean;
  constructor(message: string, passing: boolean) {
    super(message);
    this.name = 'SendFailure';
    this.passing = passing;
  }
}

/**
 * Runs a step of sending that cannot deliver anything, such as reading the draft or filing its copy,
 * so whatever it throws is a passing `SendFailure`.
 */
export async function beforeSending<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SendFailure) throw error;
    throw new SendFailure(error instanceof Error ? error.message : String(error), true);
  }
}

/** Where a moved message was, and where it is now. */
export type Moved = { from: MessageRef; to: MessageRef };

/** Where a folder's sync stopped. It belongs to the provider and is opaque to the Mailroom. */
export type Cursor = string;

/** Only messages newer than `since`, an ISO 8601 date, are reported. */
export type SyncWindow = { since: string };

/** One batch of a folder's sync. */
export type SyncBatch = { events: SyncEvent[]; cursor: Cursor; more: boolean };
