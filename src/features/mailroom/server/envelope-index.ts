import {
  applySyncEvent,
  bundleIdOf,
  bundleSummaryOf,
  domainOf,
  linkIdsOf,
  searchWords,
  threadOf,
  type Address,
  type BundleId,
  type BundleSummary,
  type ConversationId,
  type ConversationSummary,
  type Envelope,
  type Folder,
  type FolderRef,
  type FolderRole,
  type GitHubThread,
  type Index,
  type ListItem,
  type Message,
  type MessageRef,
  type SyncEvent,
  type View,
} from '../../mail/core/index.ts';
import {
  MATCHES_LISTED,
  PAGE_SIZE,
  type BundlePage,
  type Page,
  type PageAt,
} from '../client/contract.ts';
import { senderOf } from '../core/avatars.ts';
import { isNotedAlike, peopleIn } from './people.ts';
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
 * sender other than the member, and the people it holds leave the member out.
 */
export function envelopeIndex(sql: Sql, own: () => readonly string[] = () => []) {
  const ownNow = () => new Set(own().map((address) => address.toLowerCase()));
  const people = peopleIn(sql);
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
   * its search row changes only with its words. A new one arrives with them. Each notes whom it
   * puts the member, whose addresses are `mine`, in touch with. Adds the conversations it touched
   * to `touched`, and the people to `met`.
   */
  function write(
    change: ReturnType<typeof applySyncEvent>,
    mine: ReadonlySet<string>,
    touched: Set<ConversationId>,
    met: Set<string>,
  ) {
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
      people.drop(ref, met);
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
        const was = JSON.parse(before.message) as Envelope;
        // Most changes are to flags, which note nobody anew.
        if (!isNotedAlike(was, message)) people.note(message, reads.role(message), mine, met);
        const words = searchRowOf(message);
        if (words.join('\n') !== searchRowOf({ ...was, conversation }).join('\n')) {
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
      people.note(message, reads.role(message), mine, met, true);
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
   * returns its latest message in each folder it is placed in now, and the bundles it was in and is
   * in now. It is in its account's bundle for a repository while its Inbox holds only notifications
   * of one of that repository's threads, and its Inbox placement says so.
   */
  function summarize(
    id: ConversationId,
    roles: Map<string, FolderRole | undefined>,
    mine: ReadonlySet<string>,
  ): { placed: Message[]; bundles: BundleId[] } {
    const bundles = sql
      .all<{ bundle: string | null }>(`SELECT bundle FROM conversations WHERE id = ?`, id)
      .flatMap(({ bundle }) => (bundle === null ? [] : [bundle]));
    sql.run(`DELETE FROM placements WHERE conversation = ?`, id);
    const messages = reads.conversation(id);
    const row = summaryOf(id, messages, mine);
    if (!row) {
      sql.run(`DELETE FROM conversations WHERE id = ?`, id);
      return { placed: [], bundles };
    }
    const roleOf = (message: Message) => roles.get(placeOf(message));
    const inbox = messages.filter((m) => roleOf(m) === 'inbox');
    const github = inbox.length > 0 ? threadOf(inbox) : undefined;
    const summary: ConversationSummary = github ? { ...row, github } : row;
    const bundle = github ? bundleIdOf(summary.account, github.repository) : null;
    if (bundle !== null) bundles.push(bundle);
    // Where its unread mail is, which is where it is listed as unread, as each folder counts it.
    const unreadIn = new Set(messages.filter((m) => !m.flags.seen).map(placeOf));
    sql.run(
      `INSERT OR REPLACE INTO conversations (id, date, summary, inbox, drafts, flagged, bundle, unread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      summary.date,
      JSON.stringify(summary),
      Number(inbox.length > 0),
      Number(messages.some((m) => roleOf(m) === 'drafts')),
      Number(summary.flagged),
      bundle,
      Number(inbox.some((m) => unreadIn.has(placeOf(m)))),
    );
    const latest = new Map<string, Message>();
    for (const message of messages) {
      const key = placeOf(message);
      const held = latest.get(key);
      if (!held || held.date < message.date) latest.set(key, message);
    }
    for (const message of latest.values()) {
      sql.run(
        `INSERT INTO placements (account, path, conversation, date, bundle, unread)
         VALUES (?, ?, ?, ?, ?, ?)`,
        message.account,
        message.path,
        id,
        message.date,
        roleOf(message) === 'inbox' ? bundle : null,
        Number(unreadIn.has(placeOf(message))),
      );
    }
    return { placed: [...latest.values()], bundles };
  }

  /**
   * Brings a bundle's row in line with the conversations it now holds, listed in the Inbox its
   * newest one is in, and returns the Inbox it was listed in and the one it is listed in now.
   */
  function rebundle(id: BundleId): FolderRef[] {
    const was = sql.all<FolderRef>(`SELECT account, path FROM bundles WHERE id = ?`, id);
    const threads = sql
      .all<BundledRow>(
        `SELECT id, date, flagged,
           json_extract(summary, '$.account') AS account,
           json_extract(summary, '$.count') AS count,
           json_extract(summary, '$.unread') AS unread,
           json_extract(summary, '$.avatar') AS avatar,
           json_extract(summary, '$.github') AS github
         FROM conversations WHERE bundle = ? ORDER BY date DESC, id DESC`,
        id,
      )
      .map((row) => ({
        account: row.account,
        date: row.date,
        count: row.count,
        unread: row.unread,
        flagged: row.flagged === 1,
        ...(row.avatar === null ? {} : { avatar: row.avatar }),
        github: JSON.parse(row.github) as GitHubThread,
      }));
    const summary = bundleSummaryOf(id, threads);
    const [newest] = sql.all<FolderRef>(
      `SELECT p.account, p.path FROM conversations c JOIN placements p ON p.conversation = c.id
       WHERE c.bundle = ? AND p.bundle = c.bundle ORDER BY c.date DESC, c.id DESC LIMIT 1`,
      id,
    );
    if (!summary || !newest) {
      sql.run(`DELETE FROM bundles WHERE id = ?`, id);
      return was;
    }
    const [{ unread } = { unread: 0 }] = sql.all<{ unread: number }>(
      `SELECT EXISTS (SELECT 1 FROM conversations WHERE bundle = ? AND unread = 1) AS unread`,
      id,
    );
    sql.run(
      `INSERT OR REPLACE INTO bundles (id, account, path, date, summary, unread)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      newest.account,
      newest.path,
      summary.date,
      JSON.stringify(summary),
      unread,
    );
    return [...was, newest];
  }

  /**
   * Summarizes the conversations given again, then the bundles they were in and are in now, and
   * returns the folders whose lists changed: where each was placed and is placed now, or with
   * `quietly`, only where its row changed.
   */
  function settle(
    ids: Iterable<ConversationId>,
    roles: Map<string, FolderRole | undefined>,
    quietly = false,
  ): FolderRef[] {
    const changed = new Map<string, FolderRef>();
    const note = ({ account, path }: FolderRef) =>
      changed.set(placeOf({ account, path }), { account, path });
    const touched = new Set<BundleId>();
    const mine = ownNow();
    for (const id of ids) {
      const rowOf = () =>
        JSON.stringify(
          sql.all(`SELECT summary, bundle FROM conversations WHERE id = ?`, id)[0] ?? null,
        );
      const before = quietly ? rowOf() : undefined;
      // Where it was placed, and where it is placed now.
      const was = sql.all<FolderRef>(
        `SELECT account, path FROM placements WHERE conversation = ?`,
        id,
      );
      const { placed, bundles } = summarize(id, roles, mine);
      if (quietly && rowOf() === before) continue;
      bundles.forEach((bundle) => touched.add(bundle));
      was.forEach(note);
      placed.forEach(note);
    }
    for (const bundle of touched) rebundle(bundle).forEach(note);
    return [...changed.values()];
  }

  /**
   * One page of a list that merges `parts`, each a query of `id` and `date`, newest first and ties
   * by id, and how many rows they hold.
   */
  function listed(parts: readonly Part[], asked: PageAt, size: number): Page {
    const { rows, at } = pageOf(parts, asked, size);
    const [{ total } = { total: 0 }] = sql.all<{ total: number }>(
      `SELECT ${parts.map((part) => `(SELECT COUNT(*) FROM (${part.sql}))`).join(' + ')} AS total`,
      ...parts.flatMap((part) => part.params),
    );
    return { items: rows.map(itemIn), at, total };
  }

  /**
   * The query of a list's rows of one kind, as `id` and `date`: those `select` reads that meet every
   * condition in `where`, or, of a list of unread mail, the unread ones and beside them the read one
   * whose `key` is `keep`, which stays listed while it is open. Each is its own range of an index,
   * so the list still merges them newest first.
   */
  function part(
    { select, key, where, params }: PartOf,
    unread: { keep: string | undefined } | undefined,
  ): Part {
    const query = (...more: string[]) =>
      [select, [...where, ...more].join(' AND ')].filter(Boolean).join(' WHERE ');
    if (!unread) return { sql: query(), params };
    if (unread.keep === undefined) return { sql: query('unread = 1'), params };
    return {
      sql: `${query('unread = 1')} UNION ALL ${query('unread = 0', `${key} = ?`)}`,
      params: [...params, ...params, unread.keep],
    };
  }

  /**
   * The rows of one page of a list that merges `parts`, each a query of `id` and `date`, newest
   * first and ties by id, and where the page starts. A page asked at a place passes over the rows
   * above it. One asked around a row counts them instead, and reads outward from the row, so it
   * costs no more however deep the row lies.
   */
  function pageOf(
    parts: readonly Part[],
    asked: PageAt,
    size: number,
  ): { rows: { summary: string }[]; at: number } {
    const all = parts.map((part) => part.sql).join(' UNION ALL ');
    const each = parts.flatMap((part) => part.params);
    const row = typeof asked === 'number' ? undefined : rowAmong(parts, asked.around);
    const at = startOf(asked, size, () => row?.place);
    const summaries = (page: string, ...bound: SqlValue[]) =>
      sql.all<{ summary: string }>(
        `SELECT coalesce(c.summary, b.summary) AS summary FROM (${page}) p
         LEFT JOIN conversations c ON c.id = p.id LEFT JOIN bundles b ON b.id = p.id
         ORDER BY p.date DESC, p.id DESC`,
        ...bound,
      );
    if (!row) {
      const page = `${all} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`;
      return { rows: summaries(page, ...each, size, at), at };
    }
    const above = row.place - at;
    const page = `
      SELECT * FROM (
        SELECT id, date FROM (${all}) WHERE (date, id) > (?, ?) ORDER BY date, id LIMIT ?
      ) UNION ALL SELECT * FROM (
        SELECT id, date FROM (${all}) WHERE (date, id) <= (?, ?) ORDER BY date DESC, id DESC LIMIT ?
      )`;
    const from = [row.date, row.id];
    return { rows: summaries(page, ...each, ...from, above, ...each, ...from, size - above), at };
  }

  /**
   * A row of a list that merges `parts`, each a query of `id` and `date`, newest first and ties by
   * id, with its place, which is how many rows come before it, or nothing when none of them holds
   * it.
   */
  function rowAmong(
    parts: readonly Part[],
    id: string,
  ): { id: string; date: string; place: number } | undefined {
    const [held] = parts.flatMap((part) =>
      sql.all<{ date: string }>(`SELECT date FROM (${part.sql}) WHERE id = ?`, ...part.params, id),
    );
    if (!held) return undefined;
    const place = parts.reduce(
      (above, part) =>
        above +
        sql.all<{ above: number }>(
          `SELECT COUNT(*) AS above FROM (${part.sql}) WHERE (date, id) > (?, ?)`,
          ...part.params,
          held.date,
          id,
        )[0]!.above,
      0,
    );
    return { id, date: held.date, place };
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
        const mine = ownNow();
        people.owed(mine);
        const touched = new Set<ConversationId>();
        const met = new Set<string>();
        for (const event of events) write(applySyncEvent(reads, event), mine, touched, met);
        people.recount(met);
        for (const rowid of [...unwritten.keys()].sort((a, b) => a - b)) {
          sql.run(
            `INSERT INTO search (rowid, senders, recipients, subject, preview) VALUES (?, ?, ?, ?, ?)`,
            rowid,
            ...unwritten.get(rowid)!,
          );
        }
        return settle(touched, roles);
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
      const held = new Map(
        sql
          .all<{ path: string; role: string | null }>(
            `SELECT path, role FROM folders WHERE account = ?`,
            account,
          )
          .map(({ path, role }) => [path, role ?? undefined]),
      );
      const gone = [...held.keys()].filter((path) => !listed.has(path));
      // A folder's role decides whether its mail counts for the people the index holds.
      if (folders.some(({ path, role }) => held.has(path) && held.get(path) !== role)) {
        people.refill();
      }
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
     * One page of a view, newest first: `size` rows from its place `at`, with 0 the newest, or the
     * page holding the row `at` names, and how many the view holds. An Inbox view lists the
     * conversations no bundle holds and the bundles beside them, merging the two as far as the
     * page's place by id alone, and reads only the page's own rows. A view of unread mail lists its
     * unread rows, and the read one `keep` names, if it holds it.
     */
    page(
      view: Exclude<View, { in: 'search' } | { in: 'outbox' }>,
      asked: PageAt = 0,
      size = PAGE_SIZE,
      keep?: ConversationId,
    ): Page {
      if (view.in === 'folder' || view.in === 'inbox') {
        const unread = view.unread ? { keep } : undefined;
        const bundles = { select: `SELECT id, date FROM bundles`, key: 'id' };
        if (view.in === 'folder') {
          const { account, path } = view.folder;
          const where = ['account = ?', 'path = ?'];
          return listed(
            [
              part(
                {
                  select: `SELECT conversation AS id, date FROM placements`,
                  key: 'conversation',
                  where: [...where, 'bundle IS NULL'],
                  params: [account, path],
                },
                unread,
              ),
              part({ ...bundles, where, params: [account, path] }, unread),
            ],
            asked,
            size,
          );
        }
        return listed(
          [
            part(
              {
                select: `SELECT id, date FROM conversations`,
                key: 'id',
                where: ['inbox = 1', 'bundle IS NULL'],
                params: [],
              },
              unread,
            ),
            part({ ...bundles, where: [], params: [] }, unread),
          ],
          asked,
          size,
        );
      }
      const listedIn = `SELECT id, date FROM conversations WHERE ${view.in} = 1`;
      return listed([{ sql: listedIn, params: [] }], asked, size);
    },

    /**
     * One page of a bundle's conversations, newest first, with the bundle's row, or nothing of a
     * bundle that holds none.
     */
    bundle(id: BundleId, asked: PageAt = 0, size = PAGE_SIZE): BundlePage {
      const threads = `SELECT id, date FROM conversations WHERE bundle = ?`;
      const { rows, at } = pageOf([{ sql: threads, params: [id] }], asked, size);
      const [held] = sql.all<{ summary: string }>(`SELECT summary FROM bundles WHERE id = ?`, id);
      if (!held) return { items: [], at, total: 0 };
      const bundle = JSON.parse(held.summary) as BundleSummary;
      return { bundle, items: rows.map(summaryIn), at, total: bundle.threads };
    },

    /**
     * The messages a change to a bundle acts on, of those its conversations held by `through`, its
     * row's date: those in their Inbox, every one, or each conversation's newest.
     */
    bundled(id: BundleId, through: string, reach: 'inbox' | 'every' | 'newest'): Message[] {
      const roles = rolesNow();
      return sql
        .all<{ id: string }>(`SELECT id FROM conversations WHERE bundle = ?`, id)
        .flatMap(({ id: conversation }) => {
          const held = reads.conversation(conversation).filter((m) => m.date <= through);
          if (reach === 'inbox') return held.filter((m) => roles.get(placeOf(m)) === 'inbox');
          if (reach === 'every') return held;
          const newest = held.reduce<Message | undefined>(
            (found, m) => (found && found.date >= m.date ? found : m),
            undefined,
          );
          return newest ? [newest] : [];
        });
    },

    /**
     * Makes up to `most` conversations' rows again from the messages the index holds, from where
     * `RESUMMARIZE` left off, and their bundles' after them. Returns the folders whose lists
     * changed, and whether rows are left to make. Run it inside a transaction.
     */
    resummarize(most: number): { changed: FolderRef[]; done: boolean } {
      const [cursor] = sql.all<{ after: string }>(`SELECT after FROM resummarize`);
      if (!cursor) return { changed: [], done: true };
      const ids = sql
        .all<{ id: string }>(
          `SELECT id FROM conversations WHERE id > ? ORDER BY id LIMIT ?`,
          cursor.after,
          most,
        )
        .map(({ id }) => id);
      const changed = settle(ids, rolesNow(), true);
      const last = ids.at(-1);
      if (ids.length < most || last === undefined) sql.run(`DELETE FROM resummarize`);
      else sql.run(`UPDATE resummarize SET after = ?`, last);
      return { changed, done: ids.length < most };
    },

    /**
     * One page of the conversations with a message whose senders, recipients, subject or preview
     * hold every word of `text`, each word as typed so far, across every account: `size` of them
     * from place `at`, or around the conversation it names, and how many are listed. They come
     * newest first by the newest message that matches, and each row shows that message. A search lists at most its newest `most`, so it
     * reads matches newest first and stops there, and a first letter costs no more than a word.
     */
    search(
      text: string,
      asked: PageAt = 0,
      size = PAGE_SIZE,
      most = MATCHES_LISTED,
    ): Page<ConversationSummary> {
      const match = matchOf(text);
      if (!match) return { items: [], at: startOf(asked, size, () => undefined), total: 0 };
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
      const listed = [...newest];
      const at = startOf(asked, size, (id) =>
        placeIn(listed, ([conversation]) => conversation === id),
      );
      const items = listed.slice(at, at + size).flatMap(([conversation, rowid]) => {
        const [row] = sql.all<{ summary: string }>(
          `SELECT summary FROM conversations WHERE id = ?`,
          conversation,
        );
        const [message] = sql.all<Row>(`SELECT ${COLUMNS} FROM messages WHERE rowid = ?`, rowid);
        return row && message ? [matchedRow(summaryIn(row), messageOf(message))] : [];
      });
      return { items, at, total: newest.size };
    },

    /**
     * Whom an address field completes `typed` to: up to `most` of the people the index holds, other
     * than the member, as `Queries.people` ranks them.
     */
    people(typed: string, most?: number): Address[] {
      const match = matchOf(typed);
      return match ? people.complete(match, ownNow(), most) : [];
    },

    /**
     * Notes whom up to `most` of the messages owed a note put the member in touch with, from where
     * the fill left off, and recounts them. Returns whether messages are left to note. Run it inside
     * a transaction.
     */
    fillPeople(most: number): boolean {
      const mine = ownNow();
      const after = people.owed(mine);
      if (after === undefined) return false;
      const rows = sql.all<Row & { rowid: number }>(
        `SELECT rowid, ${COLUMNS} FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        after,
        most,
      );
      const roles = rolesNow();
      const met = new Set<string>();
      for (const row of rows) {
        const message = messageOf(row);
        people.note(message, roles.get(placeOf(message)), mine, met);
      }
      people.recount(met);
      const isMore = rows.length === most;
      people.filled(isMore ? rows.at(-1)!.rowid : undefined);
      return isMore;
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
      people.forget(account);
      sql.run(
        `DELETE FROM search WHERE rowid IN (SELECT rowid FROM messages WHERE account = ?)`,
        account,
      );
      for (const table of [
        'messages',
        'links',
        'folders',
        'placements',
        'bundles',
        'reread',
        'gone_bodies',
      ])
        sql.run(`DELETE FROM ${table} WHERE account = ?`, account);
      for (const { conversation } of ids)
        sql.run(`DELETE FROM conversations WHERE id = ?`, conversation);
      // A deleted search row stays readable in the table's segments until they merge, so they merge now.
      sql.run(`INSERT INTO search (search) VALUES ('optimize')`);
      sql.run(`INSERT INTO people_search (people_search) VALUES ('optimize')`);
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
  // Each sender as their newest message names them, as GitHub names whoever acted from one address.
  const senders = new Map<string, Address>();
  for (const { from } of newestFirst) {
    const key = from.email.toLowerCase();
    if (!senders.has(key)) senders.set(key, from);
  }
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
export function pageAfter(
  rows: readonly ConversationSummary[],
  asked: PageAt = 0,
  size = PAGE_SIZE,
): Page<ConversationSummary> {
  const at = startOf(asked, size, (id) => placeIn(rows, (row) => row.id === id));
  return { items: rows.slice(at, at + size), at, total: rows.length };
}

/**
 * Where a page starts: at the place asked for, or at the page of `size` holding the row asked
 * around, from the place `placeOfRow` finds for it, or at the top of a list that doesn't hold it.
 */
function startOf(
  asked: PageAt,
  size: number,
  placeOfRow: (id: string) => number | undefined,
): number {
  if (typeof asked === 'number') return asked;
  const place = placeOfRow(asked.around);
  return place === undefined ? 0 : place - (place % size);
}

/** The place of the first row that is the one sought, or nothing when none is. */
function placeIn<Row>(rows: readonly Row[], isIt: (row: Row) => boolean): number | undefined {
  const place = rows.findIndex(isIt);
  return place < 0 ? undefined : place;
}

/** A conversation's row, as the index keeps it. */
const summaryIn = ({ summary }: { summary: string }) => JSON.parse(summary) as ConversationSummary;

/** A conversation's or a bundle's row, as the index keeps it. */
const itemIn = ({ summary }: { summary: string }) => JSON.parse(summary) as ListItem;

/** A query of a list's rows of one kind, and the values it takes. */
type Part = { sql: string; params: readonly SqlValue[] };

/**
 * What a list's rows of one kind are read from: a `SELECT` of `id` and `date`, the column that
 * names a row, the conditions a row meets, and the values they take.
 */
type PartOf = {
  select: string;
  key: string;
  where: readonly string[];
  params: readonly SqlValue[];
};

/** What a bundle's row is made from, of each conversation it holds. */
type BundledRow = {
  id: string;
  account: string;
  date: string;
  flagged: number;
  count: number;
  unread: number;
  avatar: string | null;
  github: string;
};

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
