/**
 * The Mailroom's storage, as SQL that runs the same on a Durable Object's SQLite and on Bun's.
 * Each version is applied once, in order, when a Mailroom wakes. Versions are only ever appended,
 * so any Mailroom moves forward from whatever version it last ran.
 *
 * Only `accounts`, `credentials`, `demo`, `outbox` and `devices` hold what Trail Mix owns. Every
 * other table is the envelope index, which sync rebuilds from the mail servers, or a note that
 * costs nothing to lose.
 */

/** What a Mailroom reads and writes through, on either runtime. */
export type Sql = {
  all<Row = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): Row[];
  /** Rows one at a time, read only as far as the caller goes. */
  each<Row = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): Iterable<Row>;
  run(query: string, ...params: SqlValue[]): void;
  /** Runs `work` so that every write in it lands, or none does. */
  transaction<T>(work: () => T): T;
};
export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;

/**
 * Has every folder read again from its server, keeping what the index holds meanwhile, as a version
 * does when what an envelope says has been read better since. Its sync starts over, each message it
 * reports folds in place, and what the pass didn't report goes once it ends.
 */
export const REREAD = `UPDATE folders SET cursor = NULL, rereading = 1`;

/**
 * Has the Body cache swept once, from its first key, for bodies of messages the index doesn't hold,
 * as a version does after a release that kept them. A Mailroom with no account has none to sweep.
 */
export const SWEEP_BODIES = `INSERT OR REPLACE INTO body_sweep (one, after)
  SELECT 1, NULL WHERE EXISTS (SELECT 1 FROM accounts)`;

/** The member's addresses, as every account names its own, in lower case. */
const OWN = `SELECT lower(json_extract(account, '$.address')) FROM accounts`;

/** A recipient `r`'s address. */
const TO = `json_extract(r.value, '$.email')`;

/**
 * Whether a recipient `r` is someone other than the member, at an address with a domain after its
 * last `@`, as `domainOf` reads it: what follows the address trimmed of everything but `@` from
 * its end.
 */
const WRITTEN = `instr(${TO}, '@') > 0
  AND trim(replace(${TO}, rtrim(${TO}, replace(${TO}, '@', '')), '')) <> ''
  AND lower(${TO}) NOT IN (${OWN})`;

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
  [
    // Search: each message's senders, recipients, subject and preview, by the message's rowid.
    // Tokens lose their accents.
    `CREATE VIRTUAL TABLE search USING fts5(
      senders, recipients, subject, preview,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '1 2 3'
    )`,
    // Search results, like the folder views, read newest first, but across every conversation.
    `CREATE INDEX conversations_by_date ON conversations (date DESC, id DESC)`,
    // The index rebuilds from the servers with search filled in, since everything in it can.
    `DELETE FROM messages`,
    `DELETE FROM links`,
    `DELETE FROM conversations`,
    `DELETE FROM placements`,
    `UPDATE folders SET cursor = NULL`,
  ],
  [
    // The same search without prefix indexes. They wrote every word four times for a few
    // milliseconds of a search that typed one letter, and a word typed so far matches without them.
    `DROP TABLE search`,
    `CREATE VIRTUAL TABLE search USING fts5(
      senders, recipients, subject, preview,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
    `DELETE FROM messages`,
    `DELETE FROM links`,
    `DELETE FROM conversations`,
    `DELETE FROM placements`,
    `UPDATE folders SET cursor = NULL`,
  ],
  [
    // Accounts gained the name their mail is from. A demo account's mail has always been from
    // Sam Rivera, so one made before now says so. An IMAP account has none until the member sets it.
    `UPDATE accounts SET account = json_set(account, '$.fromName', 'Sam Rivera')
      WHERE json_extract(connection, '$.provider') = 'demo'`,
  ],
  [
    // The Outbox: each send the member scheduled, as the Outbox's state machine left it. Trail Mix
    // owns it, so nothing rebuilds it.
    `CREATE TABLE outbox (id TEXT PRIMARY KEY, account TEXT NOT NULL, outgoing TEXT NOT NULL)`,
  ],
  [
    // Search keeps its text NFKC-normalized, as a search's words are, so the index rebuilds.
    `DROP TABLE search`,
    `CREATE VIRTUAL TABLE search USING fts5(
      senders, recipients, subject, preview,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
    `DELETE FROM messages`,
    `DELETE FROM links`,
    `DELETE FROM conversations`,
    `DELETE FROM placements`,
    `UPDATE folders SET cursor = NULL`,
  ],
  [
    // A message's rowid now orders by its date, so a search reads its matches newest first and
    // stops at a page, and a one-letter prefix index answers a first letter at once. The index
    // rebuilds with its rows numbered that way.
    `DROP TABLE search`,
    `CREATE VIRTUAL TABLE search USING fts5(
      senders, recipients, subject, preview,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '1'
    )`,
    `DELETE FROM messages`,
    `DELETE FROM links`,
    `DELETE FROM conversations`,
    `DELETE FROM placements`,
    `UPDATE folders SET cursor = NULL`,
  ],
  [
    // Sign-ins at a vendor while the member enters the code, one per address, each with its device
    // code sealed beside it until it stops. Each goes minutes after its code expires.
    `CREATE TABLE sign_ins (address TEXT PRIMARY KEY, pending TEXT NOT NULL, sealed BLOB)`,
  ],
  [
    // Zoho files its own copy in Sent, which its preset didn't say before, so an account on
    // Zoho's hosts, whatever its plan or data center, waits for that copy rather than adding one.
    `UPDATE accounts SET connection = json_set(connection, '$.filesSent', json('true'))
      WHERE json_extract(connection, '$.provider') = 'imap'
        AND (json_extract(connection, '$.imap.host') LIKE '%.zoho.%'
          OR json_extract(connection, '$.imap.host') LIKE '%.zohocloud.%')`,
  ],
  [
    // A preview now reads like its message, without Markdown's marks, table bars or rules, so the
    // index rebuilds with every preview made again.
    `DELETE FROM search`,
    `DELETE FROM messages`,
    `DELETE FROM links`,
    `DELETE FROM conversations`,
    `DELETE FROM placements`,
    `UPDATE folders SET cursor = NULL`,
  ],
  [
    // When a signed-in device last asked this Mailroom for something, in milliseconds since the
    // epoch, in its one row. A Mailroom that starts without it counts as opened then.
    `CREATE TABLE opened (one INTEGER PRIMARY KEY CHECK (one = 1), at INTEGER NOT NULL)`,
  ],
  [
    // The devices the member turned notifications on for, each by its push subscription, as JSON.
    // Trail Mix owns them, so nothing rebuilds them.
    `CREATE TABLE devices (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, added INTEGER NOT NULL)`,
    // How far each Inbox has been read for news, as JSON. Losing one only makes its next sync quiet.
    `CREATE TABLE news_marks (
      account TEXT NOT NULL,
      path TEXT NOT NULL,
      mark TEXT NOT NULL,
      PRIMARY KEY (account, path)
    )`,
  ],
  [
    // The Logo cache: per domain that sent verified mail, the logo its BIMI record names while its
    // DMARC policy enforces, when it was last looked up, and when it is next owed a lookup, in
    // milliseconds since the epoch. A domain owed nothing waits for its next verified mail.
    `CREATE TABLE logos (
      domain TEXT PRIMARY KEY,
      svg TEXT,
      checked_at INTEGER,
      due_at INTEGER
    )`,
  ],
  [
    // Each account names the senders whose mail shows on light paper in the dark theme, none yet.
    `UPDATE accounts SET account = json_set(account, '$.lightPaperFrom', json('[]'))
     WHERE json_type(account, '$.lightPaperFrom') IS NULL`,
  ],
  [
    // The Avatar cache, in place of the Logo cache. Per domain that sent verified mail, the key of
    // its BIMI logo and of its site's icon. Per verified sender, the key of their Gravatar photo.
    // Each with when it was last looked up, and when it is next owed a lookup, in milliseconds
    // since the epoch: one owed nothing waits for its next verified mail. And each picture's bytes,
    // once, under the SHA-256 of them in hex.
    `CREATE TABLE avatar_domains (
      domain TEXT PRIMARY KEY,
      logo TEXT,
      icon TEXT,
      checked_at INTEGER,
      due_at INTEGER
    )`,
    `CREATE TABLE avatar_senders (
      sender TEXT PRIMARY KEY,
      photo TEXT,
      checked_at INTEGER,
      due_at INTEGER
    )`,
    `CREATE TABLE avatar_pictures (key TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL)`,
    // The verified mail already indexed owes its senders and their domains a lookup now.
    `INSERT OR IGNORE INTO avatar_senders (sender, due_at)
     SELECT DISTINCT lower(trim(json_extract(message, '$.from.email'))), 0 FROM messages
     WHERE json_extract(message, '$.verified') = 1 AND instr(json_extract(message, '$.from.email'), '@') > 0`,
    `INSERT OR IGNORE INTO avatar_domains (domain, due_at)
     SELECT DISTINCT substr(sender, instr(sender, '@') + 1), 0 FROM avatar_senders`,
    `DROP TABLE logos`,
  ],
  [
    // A folder being read again, and what its pass has reported so far. Mail indexed before
    // senders were verified, and before previews read HTML and its entities, is read once more.
    `ALTER TABLE folders ADD COLUMN rereading INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE reread (
      account TEXT NOT NULL,
      path TEXT NOT NULL,
      uid_validity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      PRIMARY KEY (account, path, uid_validity, uid)
    )`,
    REREAD,
  ],
  [
    // A row names its latest message's To and Cc, so a conversation only the member wrote can say
    // whom it went to. Each row learns them from its latest message.
    `UPDATE conversations SET summary = coalesce(
      (SELECT json_set(conversations.summary, '$.recipients', json((
          SELECT json_group_array(json(value)) FROM (
            SELECT 0 AS part, key, value FROM json_each(latest.message, '$.to') WHERE type = 'object'
            UNION ALL
            SELECT 1 AS part, key, value FROM json_each(latest.message, '$.cc') WHERE type = 'object'
            ORDER BY part, key
          )
        )))
       FROM (
         SELECT message FROM messages
         WHERE conversation = conversations.id AND json_valid(message)
         ORDER BY json_extract(message, '$.date') DESC LIMIT 1
       ) AS latest),
      json_set(summary, '$.recipients', json('[]'))
    )
    WHERE json_valid(summary)`,
    // A row only the member wrote, by any of their addresses, pictures its first recipient who
    // isn't them and has a domain.
    `UPDATE conversations SET summary = json_set(summary, '$.avatar', (
       SELECT lower(trim(json_extract(r.value, '$.email')))
       FROM json_each(conversations.summary, '$.recipients') AS r
       WHERE ${WRITTEN}
       ORDER BY r.key LIMIT 1
     ))
     WHERE json_valid(summary)
       AND json_type(summary, '$.avatar') IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM json_each(summary, '$.senders') AS s
         WHERE lower(json_extract(summary, s.fullkey || '.email')) NOT IN (${OWN})
       )
       AND EXISTS (SELECT 1 FROM json_each(summary, '$.recipients') AS r WHERE ${WRITTEN})`,
  ],
  [
    // The messages whose bodies the Body cache owes a delete: each that left the index, and each
    // opened from outside it. A wake lets their bodies go once its sync is done. Losing one only
    // keeps a body longer.
    `CREATE TABLE gone_bodies (
      account TEXT NOT NULL,
      path TEXT NOT NULL,
      uid_validity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      PRIMARY KEY (account, path, uid_validity, uid)
    )`,
  ],
  [
    // How far the Body cache's sweep has come, in its one row while it is owed: the last key it
    // listed, or none before its first page.
    `CREATE TABLE body_sweep (one INTEGER PRIMARY KEY CHECK (one = 1), after TEXT)`,
    // Releases before `gone_bodies` kept each body after its message left, so the cache sweeps once.
    SWEEP_BODIES,
  ],
];

/**
 * Applies every version newer than the one recorded, in order, each with its record, up to `to`,
 * which a test sets to hold a Mailroom as an earlier release left it. Returns the version it found,
 * which is 0 for a new Mailroom.
 */
export function upgrade(sql: Sql, to = versions.length): number {
  sql.run(`CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL)`);
  const [row] = sql.all<{ version: number }>(`SELECT version FROM schema`);
  const current = row?.version ?? 0;
  for (let version = current + 1; version <= to; version++) {
    sql.transaction(() => {
      for (const statement of versions[version - 1] ?? []) sql.run(statement);
      sql.run(`DELETE FROM schema`);
      sql.run(`INSERT INTO schema (version) VALUES (?)`, version);
    });
  }
  return current;
}
