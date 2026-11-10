import type { Flags, Folder, MessageRef, SyncEvent } from '../mail/core/index.ts';

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
  /** Every folder, with its role where the server marks one or its name makes it plain. */
  folders(): Promise<Folder[]>;

  /**
   * One bounded batch of what changed in a folder since `cursor`, newest first. Call again from the
   * returned cursor while `more`. A null cursor, or one the provider no longer recognizes, starts
   * the folder over with a `reset`.
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
   * Submits a draft, files exactly one copy in Sent unless the host files its own, then removes
   * the draft. A draft whose Message-ID is already in Sent is only removed, so sending again does
   * not deliver again. The one case that can deliver twice is a crash after the host accepted the
   * message and before Sent has its copy: a retry submits again, with the same Message-ID, rather
   * than risk a message that never left.
   */
  send(draft: MessageRef): Promise<void>;

  /** The UIDs of a folder's messages whose text contains `text`, searched by the server. */
  search(folder: string, text: string): Promise<number[]>;

  /**
   * Calls `onChange` when the server says a folder changed, until the returned function is called.
   * Best effort: a connection can drop without notice, so the Mailroom still polls.
   */
  watch(folder: string, onChange: () => void): () => void;

  /** Creating a folder that exists, or deleting one that does not, does nothing. */
  createFolder(path: string): Promise<void>;
  renameFolder(path: string, to: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;

  /** Ends the provider's connections. A provider is not used again after this. */
  close(): Promise<void>;
}

export type { SyncEvent };

/** Where a folder's sync stopped. It belongs to the provider and is opaque to the Mailroom. */
/** Where a moved message was, and where it is now. */
export type Moved = { from: MessageRef; to: MessageRef };

export type Cursor = string;

/** Only messages newer than `since`, an ISO 8601 date, are reported. */
export type SyncWindow = { since: string };

/** One batch of a folder's sync. */
export type SyncBatch = { events: SyncEvent[]; cursor: Cursor; more: boolean };
