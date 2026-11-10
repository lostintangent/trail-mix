import {
  applySyncEvent,
  linkIdsOf,
  type ConversationId,
  type ConversationSummary,
  type Folder,
  type FolderRef,
  type FolderRole,
  type Index,
  type Message,
  type MessageRef,
  type SyncEvent,
  type View,
} from '../../mail/core/index.ts';
import type { Page, PageCursor } from '../client/contract.ts';
import type { Sql, SqlValue } from './schema.ts';

/**
 * The envelope index in SQLite. Sync folds a provider's events into it, and nothing else writes
 * to it. It answers the fold's reads exactly as the mail core's reference index does, and keeps one
 * row per conversation current, so every list is a single range read however large the index.
 */
export type EnvelopeIndex = ReturnType<typeof envelopeIndex>;

const PAGE_SIZE = 50;

export function envelopeIndex(sql: Sql) {
  /** Folder roles by folder, read once for each fold, since nothing in a fold changes them. */
  let roles: Map<string, FolderRole | undefined> | undefined;
  const rolesNow = () =>
    new Map(
      sql
        .all<{ account: string; path: string; role: string | null }>(
          `SELECT account, path, role FROM folders`,
        )
        .map((row) => [placeOf(row), (row.role ?? undefined) as FolderRole | undefined]),
    );

  const reads: Index = {
    message: (ref) =>
      sql
        .all<Row>(`SELECT ${COLUMNS} FROM messages WHERE ${BY_REF}`, ...keyOf(ref))
        .map(messageOf)[0],
    linkedConversations: (account, ids) =>
      ids.length === 0
        ? []
        : sql
            .all<{ conversation: string }>(
              `SELECT DISTINCT m.conversation FROM links l JOIN messages m
                 ON m.account = l.account AND m.path = l.path AND m.uid_validity = l.uid_validity AND m.uid = l.uid
               WHERE l.account = ? AND l.id IN (SELECT value FROM json_each(?))`,
              account,
              // One parameter however many ids, since a Durable Object binds at most 100.
              JSON.stringify(ids),
            )
            .map((row) => row.conversation),
    conversation: (id) =>
      sql.all<Row>(`SELECT ${COLUMNS} FROM messages WHERE conversation = ?`, id).map(messageOf),
    folder: ({ account, path }) =>
      sql
        .all<Row>(`SELECT ${COLUMNS} FROM messages WHERE account = ? AND path = ?`, account, path)
        .map(messageOf),
    role: (folder) => (roles ?? rolesNow()).get(placeOf(folder)),
  };

  /**
   * Writes one change: its removals, then its messages, each with its links and its search row.
   * Returns the conversations it touched.
   */
  function write(change: ReturnType<typeof applySyncEvent>, touched: Set<ConversationId>) {
    for (const ref of [...change.remove, ...change.put]) {
      const [held] = sql.all<{ rowid: number; conversation: string }>(
        `SELECT rowid, conversation FROM messages WHERE ${BY_REF}`,
        ...keyOf(ref),
      );
      if (!held) continue;
      touched.add(held.conversation);
      sql.run(`DELETE FROM search WHERE rowid = ?`, held.rowid);
      sql.run(`DELETE FROM messages WHERE rowid = ?`, held.rowid);
      sql.run(`DELETE FROM links WHERE ${BY_REF}`, ...keyOf(ref));
    }
    for (const message of change.put) {
      touched.add(message.conversation);
      const { conversation, ...envelope } = message;
      const [inserted] = sql.all<{ rowid: number }>(
        `INSERT INTO messages (account, path, uid_validity, uid, conversation, message)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING rowid`,
        ...keyOf(message),
        conversation,
        JSON.stringify(envelope),
      );
      const { senders, recipients } = searchTextOf(message);
      sql.run(
        `INSERT INTO search (rowid, senders, recipients, subject, preview) VALUES (?, ?, ?, ?, ?)`,
        inserted!.rowid,
        senders,
        recipients,
        message.subject,
        message.preview,
      );
      for (const id of linkIdsOf(message)) {
        sql.run(
          `INSERT OR IGNORE INTO links (account, id, path, uid_validity, uid) VALUES (?, ?, ?, ?, ?)`,
          message.account,
          id,
          message.path,
          message.uidValidity,
          message.uid,
        );
      }
    }
  }

  /**
   * Brings a conversation's row and its placements in line with the messages it now holds, and
   * returns its latest message in each folder it is placed in now.
   */
  function summarize(id: ConversationId, roles: Map<string, FolderRole | undefined>): Message[] {
    sql.run(`DELETE FROM placements WHERE conversation = ?`, id);
    const messages = reads.conversation(id);
    const summary = summaryOf(id, messages);
    if (!summary) {
      sql.run(`DELETE FROM conversations WHERE id = ?`, id);
      return [];
    }
    const roleOf = (message: Message) => roles.get(placeOf(message));
    sql.run(
      `INSERT OR REPLACE INTO conversations (id, date, summary, inbox, drafts, flagged) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      summary.date,
      JSON.stringify(summary),
      Number(messages.some((m) => roleOf(m) === 'inbox')),
      Number(messages.some((m) => roleOf(m) === 'drafts')),
      Number(summary.flagged),
    );
    const latest = new Map<string, Message>();
    for (const message of messages) {
      const key = placeOf(message);
      const held = latest.get(key);
      if (!held || held.date < message.date) latest.set(key, message);
    }
    for (const message of latest.values()) {
      sql.run(
        `INSERT INTO placements (account, path, conversation, date) VALUES (?, ?, ?, ?)`,
        message.account,
        message.path,
        id,
        message.date,
      );
    }
    return [...latest.values()];
  }

  return {
    reads,

    /**
     * Folds a batch of events in order, each one seeing the writes of those before it, and returns
     * the folders whose lists changed. Run it inside a transaction with the cursor it reached.
     */
    fold(events: readonly SyncEvent[]): FolderRef[] {
      roles = rolesNow();
      try {
        const touched = new Set<ConversationId>();
        for (const event of events) write(applySyncEvent(reads, event), touched);
        const changed = new Map<string, FolderRef>();
        const note = ({ account, path }: FolderRef) =>
          changed.set(placeOf({ account, path }), { account, path });
        for (const id of touched) {
          // Where it was placed, and where it is placed now.
          sql
            .all<FolderRef>(`SELECT account, path FROM placements WHERE conversation = ?`, id)
            .forEach(note);
          summarize(id, roles).forEach(note);
        }
        return [...changed.values()];
      } finally {
        roles = undefined;
      }
    },

    /** The folders an account has, as last listed, with their counts from the server. */
    folders(account?: string): Folder[] {
      return sql
        .all<{ folder: string }>(
          account === undefined
            ? `SELECT folder FROM folders ORDER BY account, path`
            : `SELECT folder FROM folders WHERE account = ? ORDER BY path`,
          ...(account === undefined ? [] : [account]),
        )
        .map((row) => JSON.parse(row.folder) as Folder);
    },

    /**
     * Records the folders a server listed. A folder it no longer lists is forgotten, messages and
     * all, so its events must be folded first. Returns the paths that are gone.
     */
    listFolders(account: string, folders: readonly Folder[]): string[] {
      const listed = new Set(folders.map((folder) => folder.path));
      const gone = sql
        .all<{ path: string }>(`SELECT path FROM folders WHERE account = ?`, account)
        .map((row) => row.path)
        .filter((path) => !listed.has(path));
      for (const folder of folders) {
        sql.run(
          `INSERT INTO folders (account, path, folder, role) VALUES (?, ?, ?, ?)
           ON CONFLICT (account, path) DO UPDATE SET folder = excluded.folder, role = excluded.role`,
          account,
          folder.path,
          JSON.stringify(folder),
          folder.role ?? null,
        );
      }
      return gone;
    },

    dropFolder(account: string, path: string) {
      sql.run(`DELETE FROM folders WHERE account = ? AND path = ?`, account, path);
    },

    cursor(account: string, path: string): string | null {
      return (
        sql.all<{ cursor: string | null }>(
          `SELECT cursor FROM folders WHERE account = ? AND path = ?`,
          account,
          path,
        )[0]?.cursor ?? null
      );
    },

    saveCursor(account: string, path: string, cursor: string) {
      sql.run(
        `UPDATE folders SET cursor = ? WHERE account = ? AND path = ?`,
        cursor,
        account,
        path,
      );
    },

    /** One page of a view, newest first. `after` is the `next` of the page before. */
    page(
      view: Exclude<View, { in: 'search' } | { in: 'outbox' }>,
      after?: PageCursor,
      size = PAGE_SIZE,
    ): Page {
      const { before, bound } = from(after);
      const rows =
        view.in === 'folder'
          ? sql.all<{ summary: string; date: string; id: string }>(
              `SELECT c.summary, p.date, p.conversation AS id FROM placements p JOIN conversations c ON c.id = p.conversation
               WHERE p.account = ? AND p.path = ? ${before.replaceAll('date', 'p.date').replaceAll('id <', 'p.conversation <')}
               ORDER BY p.date DESC, p.conversation DESC LIMIT ?`,
              view.folder.account,
              view.folder.path,
              ...bound,
              size + 1,
            )
          : sql.all<{ summary: string; date: string; id: string }>(
              `SELECT summary, date, id FROM conversations WHERE ${view.in} = 1 ${before} ORDER BY date DESC, id DESC LIMIT ?`,
              ...bound,
              size + 1,
            );
      return pageOf(rows, size);
    },

    /**
     * One page of the conversations with a message whose senders, recipients, subject or preview
     * hold every word of `text`, each word as typed so far, newest first across every account.
     */
    search(text: string, after?: PageCursor, size = PAGE_SIZE): Page {
      const match = matchOf(text);
      if (!match) return { items: [] };
      const { before, bound } = from(after);
      const rows = sql.all<{ summary: string; date: string; id: string }>(
        `SELECT summary, date, id FROM conversations
         WHERE id IN (
           SELECT m.conversation FROM search JOIN messages m ON m.rowid = search.rowid
           WHERE search MATCH ?
         ) ${before}
         ORDER BY date DESC, id DESC LIMIT ?`,
        match,
        ...bound,
        size + 1,
      );
      return pageOf(rows, size);
    },

    conversation: (id: ConversationId): Message[] =>
      [...reads.conversation(id)].sort((a, b) => a.date.localeCompare(b.date)),

    /** Forgets an account's mail and folders, leaving nothing of them on disk. */
    forget(account: string) {
      const ids = sql.all<{ conversation: string }>(
        `SELECT DISTINCT conversation FROM messages WHERE account = ?`,
        account,
      );
      sql.run(
        `DELETE FROM search WHERE rowid IN (SELECT rowid FROM messages WHERE account = ?)`,
        account,
      );
      for (const table of ['messages', 'links', 'folders', 'placements'])
        sql.run(`DELETE FROM ${table} WHERE account = ?`, account);
      for (const { conversation } of ids)
        sql.run(`DELETE FROM conversations WHERE id = ?`, conversation);
      // A deleted search row stays readable in the table's segments until they merge, so they merge now.
      sql.run(`INSERT INTO search (search) VALUES ('optimize')`);
    },
  };
}

/** A conversation's row: its latest message speaks for it, and the rest add up. */
export function summaryOf(
  id: ConversationId,
  messages: readonly Message[],
): ConversationSummary | undefined {
  const newestFirst = [...messages].sort((a, b) => b.date.localeCompare(a.date));
  const latest = newestFirst[0];
  if (!latest) return undefined;
  const senders = new Map(newestFirst.map((m) => [m.from.email.toLowerCase(), m.from]));
  return {
    id,
    account: latest.account,
    subject: latest.subject,
    senders: [...senders.values()],
    preview: latest.preview,
    date: latest.date,
    count: messages.length,
    unread: messages.filter((m) => !m.flags.seen).length,
    flagged: messages.some((m) => m.flags.flagged),
    hasAttachments: messages.some((m) => m.hasAttachments),
  };
}

/** One page of rows already in order, newest first, as the index pages its own. */
export function pageAfter(
  rows: readonly ConversationSummary[],
  after?: PageCursor,
  size = PAGE_SIZE,
): Page {
  const position = after === undefined ? undefined : positionOf(after);
  const rest = position
    ? rows.filter(
        ({ date, id }) => date < position[0] || (date === position[0] && id < position[1]),
      )
    : rows;
  return pageOf(
    rest
      .slice(0, size + 1)
      .map((row) => ({ summary: JSON.stringify(row), date: row.date, id: row.id })),
    size,
  );
}

/** The SQL that starts a page after the one a cursor ends, and its parameters. */
function from(after: PageCursor | undefined) {
  const position = after === undefined ? undefined : positionOf(after);
  return {
    before: position ? `AND (date < ? OR (date = ? AND id < ?))` : '',
    bound: position ? [position[0], position[0], position[1]] : [],
  };
}

/** A page of rows, read one past its size to know whether another follows. */
function pageOf(rows: { summary: string; date: string; id: string }[], size: number): Page {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return {
    items: items.map((row) => JSON.parse(row.summary) as ConversationSummary),
    ...(rows.length > size && last ? { next: btoa(JSON.stringify([last.date, last.id])) } : {}),
  };
}

/**
 * Search text as an FTS5 query: every word must match, each as a prefix, so results follow typing.
 * Words are runs of letters and digits, so nothing typed can be FTS5 syntax. Nothing, without one.
 */
export function matchOf(text: string): string | undefined {
  const words =
    text
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 16) ?? [];
  return words.length ? words.map((word) => `"${word}"*`).join(' ') : undefined;
}

/** Where a page cursor says the next page starts: after this date and conversation. */
function positionOf(cursor: PageCursor): [date: string, id: string] {
  try {
    const position: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(position) &&
      position.length === 2 &&
      position.every((part) => typeof part === 'string')
    ) {
      return position as [string, string];
    }
  } catch {
    // Not base64 JSON, so not a cursor this index wrote.
  }
  throw new TypeError('That is not a page cursor.');
}

/** A folder as a map key. */
const placeOf = ({ account, path }: FolderRef) => JSON.stringify([account, path]);

/** What search reads of a message's people: names and addresses, each as written. */
function searchTextOf({ from, to, cc }: Message) {
  const people = (addresses: Message['to']) =>
    addresses.map(({ name, email }) => (name ? `${name} ${email}` : email)).join(' ');
  return { senders: people([from]), recipients: people([...to, ...cc]) };
}

type Row = { message: string; conversation: string };
const COLUMNS = 'message, conversation';
const BY_REF = 'account = ? AND path = ? AND uid_validity = ? AND uid = ?';
const keyOf = (ref: MessageRef): SqlValue[] => [ref.account, ref.path, ref.uidValidity, ref.uid];
const messageOf = (row: Row): Message => ({
  ...(JSON.parse(row.message) as Omit<Message, 'conversation'>),
  conversation: row.conversation,
});
