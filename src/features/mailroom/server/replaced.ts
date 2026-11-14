import type { AccountId, MessageRef } from '../../mail/core/index.ts';
import type { Sql, SqlValue } from './schema.ts';

/**
 * The drafts newer versions replaced, which their servers owe a discard. A save answers once its
 * server holds the new version and notes the old one here as it does, so a restart leaves the old
 * one owed rather than forgotten, and the next wake discards it before its sync. Until then the
 * server holds both versions, never neither.
 */
export type ReplacedDrafts = ReturnType<typeof replacedDrafts>;

export function replacedDrafts(sql: Sql) {
  return {
    owe(draft: MessageRef) {
      sql.run(
        `INSERT OR IGNORE INTO replaced_drafts (account, path, uid_validity, uid) VALUES (?, ?, ?, ?)`,
        ...keyOf(draft),
      );
    },

    /** Every draft owed a discard, the longest owed first. */
    owed(): MessageRef[] {
      return sql
        .all<{ account: string; path: string; uid_validity: number; uid: number }>(
          `SELECT account, path, uid_validity, uid FROM replaced_drafts ORDER BY rowid`,
        )
        .map(({ account, path, uid_validity, uid }) => ({
          account,
          path,
          uidValidity: uid_validity,
          uid,
        }));
    },

    discarded(draft: MessageRef) {
      sql.run(`DELETE FROM replaced_drafts WHERE ${BY_REF}`, ...keyOf(draft));
    },

    /** Forgets an account's, as removing the account does. */
    forget(account: AccountId) {
      sql.run(`DELETE FROM replaced_drafts WHERE account = ?`, account);
    },
  };
}

const BY_REF = 'account = ? AND path = ? AND uid_validity = ? AND uid = ?';
const keyOf = (ref: MessageRef): SqlValue[] => [ref.account, ref.path, ref.uidValidity, ref.uid];
