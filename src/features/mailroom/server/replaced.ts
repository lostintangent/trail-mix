import type { AccountId, MessageRef } from '../../mail/core/index.ts';
import { BY_REF, keyOf, noteIn } from './rows.ts';
import type { Sql } from './schema.ts';

/**
 * The drafts newer versions replaced, which their servers owe a discard. A save answers once its
 * server holds the new version and notes the old one here as it does, so a restart leaves the old
 * one owed rather than forgotten, and the next wake discards it before its sync. Until then the
 * server holds both versions, never neither.
 */
export type ReplacedDrafts = ReturnType<typeof replacedDrafts>;

export function replacedDrafts(sql: Sql) {
  return {
    owe: (draft: MessageRef) => noteIn(sql, 'replaced_drafts', draft),

    /** Every draft owed a discard, the longest owed first. */
    owed(): MessageRef[] {
      return sql.all<MessageRef>(
        `SELECT account, path, uid_validity AS uidValidity, uid FROM replaced_drafts ORDER BY rowid`,
      );
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
