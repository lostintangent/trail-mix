import type { Address, Envelope, FolderRole, Message, MessageRef } from '../../mail/core/index.ts';
import { PEOPLE_LISTED } from '../client/contract.ts';
import { correspondentsOf, type Correspondent } from '../core/people.ts';
import type { Sql, SqlValue } from './schema.ts';

/**
 * The people the envelope index holds, whom the composer's To, Cc and Bcc complete from. Each
 * message notes whom it puts the member in touch with, and each person keeps a row of how often
 * the member wrote to them and they to the member, counting each Message-ID once however many
 * folders hold it, how lately, and the name to show. The fold notes each message it writes and
 * lets go of each it removes, so the people follow the mail. A fill notes every message held, a
 * batch at a time, after an upgrade and whenever the member's addresses or a folder's role change,
 * since either changes who counts. Noting a message again changes nothing, so the fill and the
 * fold may cross.
 */
export function peopleIn(sql: Sql) {
  /**
   * Notes whom a message in a folder of `role` puts the member in touch with, whose addresses are
   * `mine`, in place of what it noted before, and adds to `touched` whoever that changes. A message
   * that `isNew` to the index noted nothing before.
   */
  function note(
    message: Message,
    role: FolderRole | undefined,
    mine: ReadonlySet<string>,
    touched: Set<string>,
    isNew = false,
  ) {
    const key = keyOf(message);
    // A message without a Message-ID is one of its own.
    const id = message.messageId || JSON.stringify(key);
    const rows = correspondentsOf(message, mine, role)
      .map((person): Noted => ({ ...person, wrote: Number(person.wrote), date: message.date, id }))
      .sort(byAddress);
    const held = isNew
      ? []
      : sql
          .all<Noted>(
            `SELECT address, name, wrote, date, message AS id FROM correspondence WHERE ${BY_REF}`,
            ...key,
          )
          .sort(byAddress);
    if (JSON.stringify(rows) === JSON.stringify(held)) return;
    if (!isNew) sql.run(`DELETE FROM correspondence WHERE ${BY_REF}`, ...key);
    for (const { address } of held) touched.add(address);
    for (const { address, name, wrote, date } of rows) {
      sql.run(
        `INSERT INTO correspondence (account, path, uid_validity, uid, address, wrote, name, date, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...key,
        address,
        wrote,
        name,
        date,
        id,
      );
      touched.add(address);
    }
  }

  /** Lets go of what a message noted, as it leaves the index, and adds whom it touched. */
  function drop(ref: MessageRef, touched: Set<string>) {
    for (const { address } of sql.all<{ address: string }>(
      `DELETE FROM correspondence WHERE ${BY_REF} RETURNING address`,
      ...keyOf(ref),
    ))
      touched.add(address);
  }

  /**
   * Counts each person given again from what the messages held note of them, and lets go of whoever
   * none does. Their name is the newest they gave themselves, else the newest the member wrote to
   * them by.
   */
  function recount(addresses: Iterable<string>) {
    for (const address of addresses) {
      // Two reads each, since each reads its own index: one in Message-ID order, one in date order.
      const tier = (wrote: number) => ({
        count: sql.all<{ count: number }>(
          `SELECT count(DISTINCT message) AS count FROM correspondence WHERE address = ? AND wrote = ?`,
          address,
          wrote,
        )[0]!.count,
        latest: sql.all<{ latest: string | null }>(
          `SELECT max(date) AS latest FROM correspondence WHERE address = ? AND wrote = ?`,
          address,
          wrote,
        )[0]!.latest,
      });
      const wrote = tier(1);
      const heard = tier(0);
      const [held] = sql.all<{ id: number; name: string }>(
        `SELECT id, name FROM people WHERE address = ?`,
        address,
      );
      if (wrote.count + heard.count === 0) {
        if (!held) continue;
        sql.run(`DELETE FROM people WHERE id = ?`, held.id);
        sql.run(`DELETE FROM people_search WHERE rowid = ?`, held.id);
        continue;
      }
      const [named] = sql.all<{ name: string }>(
        `SELECT name FROM correspondence WHERE address = ? AND name <> ''
         ORDER BY wrote, date DESC LIMIT 1`,
        address,
      );
      const name = named?.name ?? '';
      const latest = (wrote.count > 0 ? wrote.latest : heard.latest) ?? '';
      const { id } = sql.all<{ id: number }>(
        `INSERT INTO people (address, name, wrote, heard, latest) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET
           name = excluded.name, wrote = excluded.wrote, heard = excluded.heard, latest = excluded.latest
         RETURNING id`,
        address,
        name,
        wrote.count,
        heard.count,
        latest,
      )[0]!;
      if (held?.name === name) continue;
      if (held) sql.run(`DELETE FROM people_search WHERE rowid = ?`, id);
      sql.run(
        `INSERT INTO people_search (rowid, name, address) VALUES (?, ?, ?)`,
        id,
        searchable(name),
        searchable(address),
      );
    }
  }

  return {
    note,
    drop,
    recount,

    /**
     * Up to `most` people whose name or address has a word starting with each word of `match`, an
     * FTS5 query, other than the member: those the member wrote to first, by how often, then those
     * who only wrote to the member, by how often, and either by how lately when that ties.
     */
    complete(match: string, mine: ReadonlySet<string>, most = PEOPLE_LISTED): Address[] {
      return sql
        .all<{ address: string; name: string }>(
          `SELECT p.address, p.name FROM people_search s JOIN people p ON p.id = s.rowid
           WHERE people_search MATCH ? AND p.address NOT IN (SELECT value FROM json_each(?))
           ORDER BY p.wrote > 0 DESC, iif(p.wrote > 0, p.wrote, p.heard) DESC, p.latest DESC,
             p.address
           LIMIT ?`,
          match,
          JSON.stringify([...mine]),
          most,
        )
        .map(({ address, name }) => (name ? { name, email: address } : { email: address }));
    },

    /**
     * Lets go of everything an account's messages noted, and of the addresses the rest were noted
     * for, which held the account's own. They change with it, so the next fold owes a fill.
     */
    forget(account: string) {
      sql.run(`DELETE FROM people_fill`);
      recount(
        new Set(
          sql
            .all<{ address: string }>(
              `DELETE FROM correspondence WHERE account = ? RETURNING address`,
              account,
            )
            .map(({ address }) => address),
        ),
      );
    },

    /**
     * The rowid after which messages are still owed a note, or nothing when none are. Every message
     * held is owed one again when the member's addresses, `mine`, aren't those messages were last
     * noted for, so the fold asks before it notes, and an index that holds none owes nothing.
     */
    owed(mine: ReadonlySet<string>): number | undefined {
      const own = JSON.stringify([...mine].sort());
      const [fill] = sql.all<{ mine: string; after: number | null }>(
        `SELECT mine, after FROM people_fill`,
      );
      if (fill?.mine === own) return fill.after ?? undefined;
      const { after } = sql.all<{ after: number | null }>(
        `INSERT OR REPLACE INTO people_fill (one, mine, after)
         VALUES (1, ?, iif(EXISTS (SELECT 1 FROM messages), -1, NULL)) RETURNING after`,
        own,
      )[0]!;
      return after ?? undefined;
    },

    /** Records how far the fill has come: the last rowid it noted, or nothing once it is done. */
    filled(after: number | undefined) {
      sql.run(`UPDATE people_fill SET after = ?`, after ?? null);
    },

    /** Owes every message a note again, as a folder's new role asks. */
    refill() {
      sql.run(`UPDATE people_fill SET after = -1`);
    },
  };
}

/** Whether a message read again notes what it did, since nothing it notes from changed. */
export const isNotedAlike = (was: Envelope, now: Envelope) =>
  was.messageId === now.messageId &&
  was.date === now.date &&
  was.list?.id === now.list?.id &&
  JSON.stringify([was.from, was.to, was.cc]) === JSON.stringify([now.from, now.to, now.cc]);

/** What a message notes of one person. */
type Noted = Omit<Correspondent, 'wrote'> & { wrote: number; date: string; id: string };

const byAddress = (a: Noted, b: Noted) =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0;

/** Text as the people search keeps it, NFKC-normalized as search's words are. */
const searchable = (text: string) => text.normalize('NFKC');

const BY_REF = 'account = ? AND path = ? AND uid_validity = ? AND uid = ?';
const keyOf = (ref: MessageRef): SqlValue[] => [ref.account, ref.path, ref.uidValidity, ref.uid];
