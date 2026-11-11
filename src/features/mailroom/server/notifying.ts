import type { AccountId, FolderRef } from '../../mail/core/index.ts';
import type { Mark, Subscription } from '../../notifications/core/index.ts';
import type { Sql } from './schema.ts';

export type Notifying = ReturnType<typeof notifying>;

/**
 * What the Mailroom keeps to notify a member's devices: each device they turned notifications on
 * for, by its push subscription, and how far each Inbox has been read for news.
 */
export function notifying(sql: Sql) {
  return {
    /** Every notified device's subscription, the earliest turned on first. */
    devices: (): Subscription[] =>
      sql
        .all<{ subscription: string }>(`SELECT subscription FROM devices ORDER BY added, endpoint`)
        .map(({ subscription }) => JSON.parse(subscription) as Subscription),

    /** Whether any device is notified, so the Mailroom checks mail sooner. */
    isAnyNotified: () => sql.all(`SELECT 1 FROM devices LIMIT 1`).length > 0,

    isNotified: (endpoint: string) =>
      sql.all(`SELECT 1 FROM devices WHERE endpoint = ?`, endpoint).length > 0,

    /** Notifies a device from now on. Subscribing again replaces its keys. */
    notify(subscription: Subscription, at: number) {
      sql.run(
        `INSERT OR REPLACE INTO devices (endpoint, subscription, added) VALUES (?, ?, ?)`,
        subscription.endpoint,
        JSON.stringify(subscription),
        at,
      );
    },

    forget(endpoint: string) {
      sql.run(`DELETE FROM devices WHERE endpoint = ?`, endpoint);
    },

    mark: ({ account, path }: FolderRef): Mark | undefined => {
      const [row] = sql.all<{ mark: string }>(
        `SELECT mark FROM news_marks WHERE account = ? AND path = ?`,
        account,
        path,
      );
      return row && (JSON.parse(row.mark) as Mark);
    },

    setMark({ account, path }: FolderRef, mark: Mark) {
      sql.run(
        `INSERT OR REPLACE INTO news_marks (account, path, mark) VALUES (?, ?, ?)`,
        account,
        path,
        JSON.stringify(mark),
      );
    },

    /** Forgets an account's marks, as it goes. */
    forgetAccount(account: AccountId) {
      sql.run(`DELETE FROM news_marks WHERE account = ?`, account);
    },
  };
}
