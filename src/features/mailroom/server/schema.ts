/**
 * The Mailroom's storage, as SQL that runs the same on a Durable Object's SQLite and on Bun's.
 * Each version is applied once, in order, when a Mailroom wakes. Versions are only ever appended,
 * so any Mailroom moves forward from whatever version it last ran.
 *
 * Only `accounts`, `credentials`, `demo` and, later, the Outbox hold what Trail Mix owns. Every
 * other table is the envelope index, which sync rebuilds from the mail servers.
 */

/** What a Mailroom reads and writes through, on either runtime. */
export type Sql = {
  all<Row = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): Row[];
  run(query: string, ...params: SqlValue[]): void;
  /** Runs `work` so that every write in it lands, or none does. */
  transaction<T>(work: () => T): T;
};
export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;

export const versions: readonly (readonly string[])[] = [
  [
    `CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      account TEXT NOT NULL,
      connection TEXT NOT NULL
    )`,
    // A secret, sealed with the member's key. Nothing reads it but the account's provider.
    `CREATE TABLE credentials (account TEXT PRIMARY KEY, sealed BLOB NOT NULL)`,
    // The demo mailbox's server: what the member changed in it.
    `CREATE TABLE demo (account TEXT PRIMARY KEY, state TEXT NOT NULL)`,

    `CREATE TABLE folders (
      account TEXT NOT NULL,
      path TEXT NOT NULL,
      folder TEXT NOT NULL,
      role TEXT,
      cursor TEXT,
      PRIMARY KEY (account, path)
    )`,
    `CREATE TABLE messages (
      account TEXT NOT NULL,
      path TEXT NOT NULL,
      uid_validity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      conversation TEXT NOT NULL,
      message TEXT NOT NULL,
      PRIMARY KEY (account, path, uid_validity, uid)
    )`,
    `CREATE INDEX messages_by_conversation ON messages (conversation)`,
    // The ids each message links through, for linking new mail to its conversation.
    `CREATE TABLE links (
      account TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      uid_validity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      PRIMARY KEY (account, id, path, uid_validity, uid)
    )`,
    `CREATE INDEX links_by_message ON links (account, path, uid_validity, uid)`,
    // One row per conversation, kept current as messages come and go, so a list is one range read.
    `CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      summary TEXT NOT NULL,
      inbox INTEGER NOT NULL,
      drafts INTEGER NOT NULL,
      flagged INTEGER NOT NULL
    )`,
    `CREATE INDEX conversations_in_inbox ON conversations (date DESC, id DESC) WHERE inbox = 1`,
    `CREATE INDEX conversations_in_drafts ON conversations (date DESC, id DESC) WHERE drafts = 1`,
    `CREATE INDEX conversations_flagged ON conversations (date DESC, id DESC) WHERE flagged = 1`,
    // Where each conversation has messages, and its latest there, for a folder's list.
    `CREATE TABLE placements (
      account TEXT NOT NULL,
      path TEXT NOT NULL,
      conversation TEXT NOT NULL,
      date TEXT NOT NULL,
      PRIMARY KEY (account, path, conversation)
    )`,
    `CREATE INDEX placements_by_date ON placements (account, path, date DESC, conversation DESC)`,
    `CREATE INDEX placements_by_conversation ON placements (conversation)`,
  ],
];

/**
 * Applies every version newer than the one recorded, in order, each with its record. Returns the
 * version it found, which is 0 for a new Mailroom.
 */
export function upgrade(sql: Sql): number {
  sql.run(`CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL)`);
  const [row] = sql.all<{ version: number }>(`SELECT version FROM schema`);
  const current = row?.version ?? 0;
  for (let version = current + 1; version <= versions.length; version++) {
    sql.transaction(() => {
      for (const statement of versions[version - 1] ?? []) sql.run(statement);
      sql.run(`DELETE FROM schema`);
      sql.run(`INSERT INTO schema (version) VALUES (?)`, version);
    });
  }
  return current;
}
