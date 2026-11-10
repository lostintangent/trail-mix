import type { AccountId } from '../../mail/core/index.ts';
import { kept, type Pending } from '../../accounts/core/index.ts';
import type { Sql } from './schema.ts';

/**
 * Sign-ins at a vendor as the Mailroom keeps them while members enter their codes: one row per
 * address, with the device code sealed beside it while it waits. Once a sign-in stops, its row
 * holds only the reason, and rows the state machine no longer keeps are deleted as they're read.
 */
export type SignInBook = ReturnType<typeof signInBook>;

export function signInBook(sql: Sql) {
  const rows = () =>
    sql
      .all<{ pending: string }>(`SELECT pending FROM sign_ins`)
      .map((row) => JSON.parse(row.pending) as Pending);
  const remove = (address: string) =>
    sql.run(`DELETE FROM sign_ins WHERE address = ?`, keyOf(address));

  return {
    /** Every sign-in still kept, and none of the rest, which go now. */
    all(now: number): Pending[] {
      const held = rows();
      for (const gone of held.filter((pending) => !kept(pending, now))) remove(gone.address);
      return held.filter((pending) => kept(pending, now));
    },

    /** A new sign-in for its address, replacing any before it, with its sealed device code. */
    start(pending: Pending, sealed: Uint8Array) {
      sql.run(
        `INSERT INTO sign_ins (address, pending, sealed) VALUES (?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET pending = excluded.pending, sealed = excluded.sealed`,
        keyOf(pending.address),
        JSON.stringify(pending),
        sealed,
      );
    },

    /**
     * A sign-in as it moved on. Only a waiting one keeps its device code. A sign-in started for the
     * same address meanwhile has replaced it, and stays as it is.
     */
    update(pending: Pending) {
      sql.run(
        `UPDATE sign_ins SET pending = ?, sealed = CASE WHEN ? THEN sealed END
         WHERE address = ? AND json_extract(pending, '$.code') = ?`,
        JSON.stringify(pending),
        pending.state === 'waiting' ? 1 : 0,
        keyOf(pending.address),
        pending.code,
      );
    },

    sealed(address: string): Uint8Array | undefined {
      const [row] = sql.all<{ sealed: ArrayBuffer | Uint8Array | null }>(
        `SELECT sealed FROM sign_ins WHERE address = ?`,
        keyOf(address),
      );
      return row?.sealed ? new Uint8Array(row.sealed) : undefined;
    },

    /** A sign-in that finished, so the account it was for says the rest, unless it was replaced. */
    finish(pending: Pending) {
      sql.run(
        `DELETE FROM sign_ins WHERE address = ? AND json_extract(pending, '$.code') = ?`,
        keyOf(pending.address),
        pending.code,
      );
    },

    /** Any sign-in for an account that has gone. */
    forget(account: AccountId) {
      for (const pending of rows()) {
        if ('account' in pending.to && pending.to.account === account) remove(pending.address);
      }
    },
  };
}

/** Addresses are one sign-in each, however they're cased. */
const keyOf = (address: string) => address.toLowerCase();
