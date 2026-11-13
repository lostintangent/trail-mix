import {
  applySyncEvent,
  domainOf,
  linkIdsOf,
  searchWords,
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
import { MATCHES_LISTED, PAGE_SIZE, type Page } from '../client/contract.ts';
import { senderOf } from '../core/avatars.ts';
import type { Sql, SqlValue } from './schema.ts';

/**
 * The envelope index in SQLite. Sync folds a provider's events into it, and nothing else writes
 * to it. It answers the fold's reads exactly as the mail core's reference index does, and keeps one
 * row per conversation current, so every list is a single range read however large the index.
 */
export type EnvelopeIndex = ReturnType<typeof envelopeIndex>;

/**
 * A message's rowid is the second its date names times this, plus a count of those before it in
 * that second, so rowids order by date and the full-text table, which shares them, reads its
 * matches newest first.
 */
const SECOND = 2 ** 20;

/**
 * `own` gives the member's addresses, so a conversation's row can name the picture of its newest
 * sender other than the member.
 */
export function envelopeIndex(sql: Sql, own: () => readonly string[] = () => []) {
  const ownNow = () => new Set(own().map((address) => address.toLowerCase()));
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

  /**
   * A fold's new search rows, written together in rowid order as it ends. FTS5 starts a new segment
   * whenever a rowid comes lower than the last, and sync reads mail newest first, so written as
   * they arrived every message would make a segment of its own.
   */
  const unwritten = new Map<number, SqlValue[]>();

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

  /** Notes that the Body cache owes a message's body a delete, should it hold one. */
  function oweBody(ref: MessageRef) {
    sql.run(
      `INSERT OR IGNORE INTO gone_bodies (account, path, uid_validity, uid) VALUES (?, ?, ?, ?)`,
      ...keyOf(ref),
    );
  }

  /**
   * Writes one change: its removals, then its messages. A message already held changes in place,
   * its flags or its conversation, or what it says when it is read again, so its links stand and
   * its search row changes only with its words. A new one arrives with them. Returns the
   * conversations it touched.
   */
  function write(change: ReturnType<typeof applySyncEvent>, touched: Set<ConversationId>) {
    const held = (ref: MessageRef) =>
      sql.all<{ rowid: number; conversation: string; message: string }>(
        `SELECT rowid, conversation, message FROM messages WHERE ${BY_REF}`,
        ...keyOf(ref),
      )[0];
    for (const ref of change.remove) {
      const gone = held(ref);
      if (!gone) continue;
      touched.add(gone.conversation);
      if (!unwritten.delete(gone.rowid)) sql.run(`DELETE FROM search WHERE rowid = ?`, gone.rowid);
      sql.run(`DELETE FROM messages WHERE rowid = ?`, gone.rowid);
      sql.run(`DELETE FROM links WHERE ${BY_REF}`, ...keyOf(ref));
      oweBody(ref);
    }
    for (const message of change.put) {
      touched.add(message.conversation);
      const { conversation, ...envelope } = message;
      const before = held(message);
      if (before) {
        touched.add(before.conversation);
        sql.run(
          `UPDATE messages SET conversation = ?, message = ? WHERE rowid = ?`,
          conversation,
          JSON.stringify(envelope),
          before.rowid,
        );
        const words = searchRowOf(message);
        const was = searchRowOf({ ...(JSON.parse(before.message) as Message), conversation });
        if (words.join('\n') !== was.join('\n')) {
          if (!unwritten.has(before.rowid)) {
            sql.run(`DELETE FROM search WHERE rowid = ?`, before.rowid);
          }
          unwritten.set(before.rowid, words);
        }
        continue;
      }
      const first = firstRowidOf(message.date);
      const [{ last } = { last: null }] = sql.all<{ last: number | null }>(
        `SELECT MAX(rowid) AS last FROM messages WHERE rowid >= ? AND rowid < ?`,
        first,
        first + SECOND,
      );
      // A second that is somehow full leaves SQLite to number the message.
      const rowid = last === null ? first : last + 1 < first + SECOND ? last + 1 : null;
      const [inserted] = sql.all<{ rowid: number }>(
        `INSERT INTO messages (rowid, account, path, uid_validity, uid, conversation, message)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rowid`,
        rowid,
        ...keyOf(message),
        conversation,
        JSON.stringify(envelope),
      );
      unwritten.set(inserted!.rowid, searchRowOf(message));
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
  function summarize(
    id: ConversationId,
    roles: Map<string, FolderRole | undefined>,
    mine: ReadonlySet<string>,
  ): Message[] {
    sql.run(`DELETE FROM placements WHERE conversation = ?`, id);
    const messages = reads.conversation(id);
    const summary = summaryOf(id, messages, mine);
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

  /** Whether a folder is being read again, as `REREAD` asks, and its pass hasn't ended. */
  function isRereading(account: string, path: string): boolean {
    return (
      sql.all<{ rereading: number }>(
        `SELECT rereading FROM folders WHERE account = ? AND path = ?`,
        account,
        path,
      )[0]?.rereading === 1
    );
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
        for (const rowid of [...unwritten.keys()].sort((a, b) => a - b)) {
          sql.run(
            `INSERT INTO search (rowid, senders, recipients, subject, preview) VALUES (?, ?, ?, ?, ?)`,
            rowid,
            ...unwritten.get(rowid)!,
          );
        }
        const changed = new Map<string, FolderRef>();
        const note = ({ account, path }: FolderRef) =>
          changed.set(placeOf({ account, path }), { account, path });
        const mine = ownNow();
        for (const id of touched) {
          // Where it was placed, and where it is placed now.
          sql
            .all<FolderRef>(`SELECT account, path FROM placements WHERE conversation = ?`, id)
            .forEach(note);
          summarize(id, roles, mine).forEach(note);
        }
        return [...changed.values()];
      } finally {
        roles = undefined;
        unwritten.clear();
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
      sql.run(`DELETE FROM reread WHERE account = ? AND path = ?`, account, path);
    },

    isRereading,

    /**
     * Notes the messages a folder's pass reported, so what it didn't can go when it ends. A batch
     * that starts the folder over starts the pass over too.
     */
    noteReread(account: string, path: string, refs: readonly MessageRef[], startsOver: boolean) {
      if (startsOver) sql.run(`DELETE FROM reread WHERE account = ? AND path = ?`, account, path);
      for (const ref of refs) {
        sql.run(
          `INSERT OR IGNORE INTO reread (account, path, uid_validity, uid) VALUES (?, ?, ?, ?)`,
          ...keyOf(ref),
        );
      }
    },

    /** Ends a folder's pass, and returns what the index holds there that it didn't report. */
    endReread(account: string, path: string): MessageRef[] {
      const left = sql
        .all<{ uid_validity: number; uid: number }>(
          `SELECT m.uid_validity, m.uid FROM messages m
            WHERE m.account = ? AND m.path = ? AND NOT EXISTS (
              SELECT 1 FROM reread r
               WHERE r.account = m.account AND r.path = m.path
                 AND r.uid_validity = m.uid_validity AND r.uid = m.uid)`,
          account,
          path,
        )
        .map(({ uid_validity, uid }) => ({ account, path, uidValidity: uid_validity, uid }));
      sql.run(`DELETE FROM reread WHERE account = ? AND path = ?`, account, path);
      sql.run(`UPDATE folders SET rereading = 0 WHERE account = ? AND path = ?`, account, path);
      return left;
    },

    /** Carries a folder's pass to the path a rename gave it, where its messages moved. */
    carryReread(account: string, from: string, to: string) {
      if (!isRereading(account, from)) return;
      sql.run(`UPDATE reread SET path = ? WHERE account = ? AND path = ?`, to, account, from);
      sql.run(`UPDATE folders SET rereading = 1 WHERE account = ? AND path = ?`, account, to);
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

    /**
     * One page of a view, newest first: `size` conversations from its place `at`, with 0 the
     * newest, and how many the view holds. A folder's page reads its placements alone as far as
     * `at`, and only the page's own conversations past it.
     */
    page(view: Exclude<View, { in: 'search' } | { in: 'outbox' }>, at = 0, size = PAGE_SIZE): Page {
      if (view.in === 'folder') {
        const { account, path } = view.folder;
        const [{ total } = { total: 0 }] = sql.all<{ total: number }>(
          `SELECT COUNT(*) AS total FROM placements WHERE account = ? AND path = ?`,
          account,
          path,
        );
        const rows = sql.all<{ summary: string }>(
          `SELECT c.summary FROM (
             SELECT conversation, date FROM placements WHERE account = ? AND path = ?
             ORDER BY date DESC, conversation DESC LIMIT ? OFFSET ?
           ) p JOIN conversations c ON c.id = p.conversation
           ORDER BY p.date DESC, p.conversation DESC`,
          account,
          path,
          size,
          at,
        );
        return { items: rows.map(summaryIn), at, total };
      }
      const [{ total } = { total: 0 }] = sql.all<{ total: number }>(
        `SELECT COUNT(*) AS total FROM conversations WHERE ${view.in} = 1`,
      );
      const rows = sql.all<{ summary: string }>(
        `SELECT summary FROM conversations WHERE ${view.in} = 1
         ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`,
        size,
        at,
      );
      return { items: rows.map(summaryIn), at, total };
    },

    /**
     * One page of the conversations with a message whose senders, recipients, subject or preview
     * hold every word of `text`, each word as typed so far, across every account: `size` of them
     * from place `at`, and how many are listed. They come newest first by the newest message that
     * matches, and each row shows that message. A search lists at most its newest `most`, so it
     * reads matches newest first and stops there, and a first letter costs no more than a word.
     */
    search(text: string, at = 0, size = PAGE_SIZE, most = MATCHES_LISTED): Page {
      const match = matchOf(text);
      if (!match) return { items: [], at, total: 0 };
      const newest = new Map<string, number>();
      for (const { rowid, conversation } of sql.each<{ rowid: number; conversation: string }>(
        `SELECT m.rowid, m.conversation FROM search JOIN messages m ON m.rowid = search.rowid
         WHERE search MATCH ? ORDER BY search.rowid DESC`,
        match,
      )) {
        if (newest.has(conversation)) continue;
        newest.set(conversation, rowid);
        if (newest.size === most) break;
      }
      const items = [...newest].slice(at, at + size).flatMap(([conversation, rowid]) => {
        const [row] = sql.all<{ summary: string }>(
          `SELECT summary FROM conversations WHERE id = ?`,
          conversation,
        );
        const [message] = sql.all<Row>(`SELECT ${COLUMNS} FROM messages WHERE rowid = ?`, rowid);
        return row && message ? [matchedRow(summaryIn(row), messageOf(message))] : [];
      });
      return { items, at, total: newest.size };
    },

    conversation: (id: ConversationId): Message[] =>
      [...reads.conversation(id)].sort((a, b) => a.date.localeCompare(b.date)),

    /** A conversation's row as the index would keep it, from the messages given. */
    summaryOf: (id: ConversationId, messages: readonly Message[]) =>
      summaryOf(id, messages, ownNow()),

    /** The senders of the verified mail the index holds. */
    verifiedSenders(): Set<string> {
      return new Set(
        sql
          .all<{ sender: string }>(
            `SELECT DISTINCT json_extract(message, '$.from.email') AS sender FROM messages
             WHERE json_extract(message, '$.verified') = 1`,
          )
          .map((row) => senderOf(row.sender)),
      );
    },

    /**
     * Notes a message the index doesn't hold whose body the cache took, as a full-text result's,
     * so its body goes as one whose message left the index does: no sync will report it gone.
     */
    oweBody,

    /** Messages whose cached bodies are owed a delete, at most `most` of them. */
    owedBodies(most: number): MessageRef[] {
      return sql
        .all<{ account: string; path: string; uid_validity: number; uid: number }>(
          `SELECT account, path, uid_validity, uid FROM gone_bodies LIMIT ?`,
          most,
        )
        .map(({ account, path, uid_validity, uid }) => ({
          account,
          path,
          uidValidity: uid_validity,
          uid,
        }));
    },

    /** Clears what was owed for bodies the cache has let go. */
    bodiesLetGo(refs: readonly MessageRef[]) {
      sql.run(
        `DELETE FROM gone_bodies WHERE (account, path, uid_validity, uid) IN (
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                  json_extract(value, '$[2]'), json_extract(value, '$[3]')
           FROM json_each(?))`,
        JSON.stringify(refs.map(keyOf)),
      );
    },

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
      for (const table of ['messages', 'links', 'folders', 'placements', 'reread', 'gone_bodies'])
        sql.run(`DELETE FROM ${table} WHERE account = ?`, account);
      for (const { conversation } of ids)
        sql.run(`DELETE FROM conversations WHERE id = ?`, conversation);
      // A deleted search row stays readable in the table's segments until they merge, so they merge now.
      sql.run(`INSERT INTO search (search) VALUES ('optimize')`);
    },
  };
}

/**
 * A conversation's row: its latest message speaks for it, and the rest add up. Its avatar is its
 * newest sender's other than the member, whose addresses are `mine`, when that message is verified.
 * When only the member wrote, it is their first recipient's, the picture the cache holds for that
 * address if any, though nothing is ever looked up for a recipient. The index keeps the address,
 * whether or not the Avatar cache holds their picture yet, and a read names the picture only once
 * the cache does.
 */
export function summaryOf(
  id: ConversationId,
  messages: readonly Message[],
  mine: ReadonlySet<string> = new Set(),
): ConversationSummary | undefined {
  const newestFirst = [...messages].sort((a, b) => b.date.localeCompare(a.date));
  const latest = newestFirst[0];
  if (!latest) return undefined;
  const senders = new Map(newestFirst.map((m) => [m.from.email.toLowerCase(), m.from]));
  const theirs = newestFirst.find((m) => !mine.has(m.from.email.toLowerCase()));
  const recipients = [...latest.to, ...latest.cc];
  const written = recipients.find(({ email }) => domainOf(email) && !mine.has(email.toLowerCase()));
  const avatar = theirs
    ? theirs.verified
      ? senderOf(theirs.from.email)
      : ''
    : written
      ? senderOf(written.email)
      : '';
  return {
    id,
    account: latest.account,
    subject: latest.subject,
    senders: [...senders.values()],
    recipients,
    preview: latest.preview,
    date: latest.date,
    count: messages.length,
    unread: messages.filter((m) => !m.flags.seen).length,
    flagged: messages.some((m) => m.flags.flagged),
    hasAttachments: messages.some((m) => m.hasAttachments),
    ...(avatar ? { avatar } : {}),
  };
}

/** A search's row: its conversation, shown by the newest message in it that matched. */
export function matchedRow(
  conversation: ConversationSummary,
  { subject, preview, date }: Pick<Message, 'subject' | 'preview' | 'date'>,
): ConversationSummary {
  return { ...conversation, subject, preview, date };
}

/** One page of rows already in order, newest first, as the index pages its own. */
export function pageAfter(rows: readonly ConversationSummary[], at = 0, size = PAGE_SIZE): Page {
  return { items: rows.slice(at, at + size), at, total: rows.length };
}

/** A conversation's row, as the index keeps it. */
const summaryIn = ({ summary }: { summary: string }) => JSON.parse(summary) as ConversationSummary;

/**
 * Search text as an FTS5 query: every word must match, each as a prefix, so results follow typing.
 * Words are runs of letters and digits, so nothing typed can be FTS5 syntax. Nothing, without one.
 */
export function matchOf(text: string): string | undefined {
  const words = searchWords(text).slice(0, 16);
  return words.length ? words.map((word) => `"${word}"*`).join(' ') : undefined;
}

/** The first rowid of the second a message's date names, within what a rowid can count to. */
function firstRowidOf(date: string): number {
  const seconds = Math.floor(Date.parse(date) / 1000);
  const second = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), 2 ** 33 - 1) : 0;
  return second * SECOND;
}

/** A folder as a map key. */
const placeOf = ({ account, path }: FolderRef) => JSON.stringify([account, path]);

/**
 * Text as the index keeps it for search. A search's words are NFKC-normalized, so what they are
 * matched against is too, and a ligature or a fullwidth letter matches its plain form either way.
 */
export const searchable = (text: string) => text.normalize('NFKC');

/** What search reads of a message's people: names and addresses, each as written. */
/** A message's row in the search table: its senders, recipients, subject and preview. */
function searchRowOf(message: Message): string[] {
  const { senders, recipients } = searchTextOf(message);
  return [
    searchable(senders),
    searchable(recipients),
    searchable(message.subject),
    searchable(message.preview),
  ];
}

function searchTextOf({ from, to, cc }: Message) {
  const people = (addresses: Message['to']) =>
    addresses.map(({ name, email }) => (name ? `${name} ${email}` : email)).join(' ');
  return { senders: people([from]), recipients: people([...to, ...cc]) };
}

type Row = { message: string; conversation: string };
const COLUMNS = 'message, conversation';
const BY_REF = 'account = ? AND path = ? AND uid_validity = ? AND uid = ?';
const keyOf = (ref: MessageRef): SqlValue[] => [ref.account, ref.path, ref.uidValidity, ref.uid];
const messageOf = (row: Row): Message => {
  const envelope = JSON.parse(row.message) as Omit<Message, 'conversation' | 'verified'> & {
    verified?: boolean;
  };
  // Mail indexed before senders were verified counts as unverified.
  return { ...envelope, verified: envelope.verified === true, conversation: row.conversation };
};
