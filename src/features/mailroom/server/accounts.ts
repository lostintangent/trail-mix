import type { Account, AccountId, StampColor } from '../../mail/core/index.ts';
import type { DemoKind, DemoMailbox, Endpoint } from '../../providers/index.ts';
import type { Sql } from './schema.ts';

/**
 * The accounts a member connected, in the order they were added, and what reaching each one
 * takes. A password is kept only sealed, in its own table, and nothing here returns it to a query.
 * A demo account's server is kept here too, since it is mail the member changed, not an index.
 */
export type AccountBook = ReturnType<typeof accountBook>;

/** How the Mailroom reaches an account's host. A secret is sealed separately. */
export type Connection =
  | { provider: 'imap'; imap: Endpoint; smtp: Endpoint; user: string; filesSent: boolean }
  | { provider: 'demo'; kind: DemoKind };

/** Stamps go to accounts in this order, each to the first account without one in use. */
export const STAMPS: readonly StampColor[] = [
  'vermilion',
  'teal',
  'violet',
  'amber',
  'green',
  'slate',
];

export function accountBook(sql: Sql) {
  const rows = () =>
    sql
      .all<{ account: string; connection: string }>(
        `SELECT account, connection FROM accounts ORDER BY position`,
      )
      .map((row) => ({
        account: JSON.parse(row.account) as Account,
        connection: JSON.parse(row.connection) as Connection,
      }));

  const find = (id: AccountId) => rows().find((row) => row.account.id === id);

  return {
    all: (): Account[] => rows().map((row) => row.account),

    /** Every account with how to reach it. */
    connections: rows,

    get: find,

    /**
     * Adds an account with the first stamp not in use, and with what it starts from: an IMAP
     * account's sealed secret, or a demo account's server.
     */
    add(
      account: Omit<Account, 'stamp' | 'status' | 'allowImagesFrom'>,
      connection: Connection,
      start: { sealed: Uint8Array } | { demo: DemoMailbox },
    ): Account {
      return sql.transaction(() => {
        const held = rows();
        const taken = new Set(held.map((row) => row.account.stamp));
        const added: Account = {
          ...account,
          stamp: STAMPS.find((stamp) => !taken.has(stamp)) ?? STAMPS[held.length % STAMPS.length]!,
          status: 'syncing',
          allowImagesFrom: [],
        };
        const [last] = sql.all<{ position: number | null }>(
          `SELECT MAX(position) AS position FROM accounts`,
        );
        sql.run(
          `INSERT INTO accounts (id, position, account, connection) VALUES (?, ?, ?, ?)`,
          added.id,
          (last?.position ?? -1) + 1,
          JSON.stringify(added),
          JSON.stringify(connection),
        );
        if ('sealed' in start) {
          sql.run(
            `INSERT INTO credentials (account, sealed) VALUES (?, ?)`,
            added.id,
            start.sealed,
          );
        } else {
          sql.run(
            `INSERT INTO demo (account, state) VALUES (?, ?)`,
            added.id,
            JSON.stringify(start.demo),
          );
        }
        return added;
      });
    },

    /** Changes what the member sees of an account. Returns false when there is no such account. */
    update(id: AccountId, change: (account: Account) => Account): boolean {
      const held = find(id);
      if (!held) return false;
      const next = change(held.account);
      if (JSON.stringify(next) === JSON.stringify(held.account)) return true;
      sql.run(`UPDATE accounts SET account = ? WHERE id = ?`, JSON.stringify(next), id);
      return true;
    },

    /** Forgets an account, its secret and its demo server. */
    remove(id: AccountId) {
      sql.transaction(() => {
        sql.run(`DELETE FROM accounts WHERE id = ?`, id);
        sql.run(`DELETE FROM credentials WHERE account = ?`, id);
        sql.run(`DELETE FROM demo WHERE account = ?`, id);
      });
    },

    sealed(id: AccountId): Uint8Array | undefined {
      const [row] = sql.all<{ sealed: ArrayBuffer | Uint8Array }>(
        `SELECT sealed FROM credentials WHERE account = ?`,
        id,
      );
      return row && new Uint8Array(row.sealed);
    },

    demo(id: AccountId): DemoMailbox | undefined {
      const [row] = sql.all<{ state: string }>(`SELECT state FROM demo WHERE account = ?`, id);
      return row && (JSON.parse(row.state) as DemoMailbox);
    },

    /** Keeps a demo account's server as it changes, in the same turn, as the provider expects. */
    saveDemo(id: AccountId, mailbox: DemoMailbox) {
      sql.run(`UPDATE demo SET state = ? WHERE account = ?`, JSON.stringify(mailbox), id);
    },
  };
}
