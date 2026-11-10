import type { AccountId, Hint, MessageRef, Outgoing } from '../../mail/core/index.ts';
import * as outbox from '../../outbox/index.ts';
import { SendFailure, type MailProvider } from '../../providers/index.ts';
import type { Sql } from './schema.ts';
import { WAKE } from './sync.ts';

/**
 * The Outbox as the Mailroom keeps and drives it: the member's schedule of drafts to send, stored
 * one row per send, and carried through the Outbox's state machine by the alarm. Every change is
 * stored before the next step reaches a mail server, so a wake cut short anywhere resumes from the
 * last change, and every change hints the member's devices.
 *
 * A Mailroom calls `recover` once as it starts, before anything else can begin a send, so a send it
 * finds mid-submit was cut short by the restart.
 */
export type OutboxQueue = ReturnType<typeof outboxQueue>;

export type Sending = {
  sql: Sql;
  provider: (account: AccountId) => Promise<MailProvider>;
  hint: (hint: Hint) => void;
  /** Hears that a send has left Drafts and has its copy in Sent, so those folders sync. */
  sent: (outgoing: Outgoing) => void;
  /** Runs once the host has accepted a message, before the Outbox records it. Tests stop here. */
  accepted?: () => void;
};

export function outboxQueue(sending: Sending) {
  const { sql, hint } = sending;
  let running = false;

  const all = (): Outgoing[] =>
    sql
      .all<{ outgoing: string }>(`SELECT outgoing FROM outbox`)
      .map((row) => JSON.parse(row.outgoing) as Outgoing);
  const get = (id: string) => all().find((held) => held.id === id);
  const put = (outgoing: Outgoing) =>
    sql.run(
      `INSERT INTO outbox (id, account, outgoing) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET outgoing = excluded.outgoing`,
      outgoing.id,
      outgoing.draft.account,
      JSON.stringify(outgoing),
    );
  const changed = () => hint({ changed: 'outbox' });
  const owned = (id: string) => {
    const held = get(id);
    if (!held) throw new Error('There is no such send.');
    return held;
  };

  /** Runs one step of a send, and stores what it came to, unless the send went while it ran. */
  async function step({ step: next, outgoing }: outbox.Due, now: () => string) {
    const { id, draft, messageId } = outgoing;
    const provider = () => sending.provider(draft.account);
    if (next === 'submit') {
      const begun = outbox.begin(outgoing);
      put(begun);
      changed();
      const outcome = await attempt(async () => (await provider()).submit(draft, messageId));
      if (outcome === 'sent') sending.accepted?.();
      if (!get(id)) return;
      put(outbox.submitted(begun, outcome, now()));
    } else {
      const outcome = await attempt(async () => {
        await (await provider()).file(draft, messageId);
        return 'filed' as const;
      });
      if (!get(id)) return;
      const result = outbox.filed(outgoing, outcome, now());
      if (result === 'done') {
        sql.run(`DELETE FROM outbox WHERE id = ?`, id);
        sending.sent(outgoing);
      } else {
        put(result);
      }
    }
    changed();
  }

  return {
    /** Every send, soonest first. */
    list(): Outgoing[] {
      return all().toSorted((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id.localeCompare(b.id));
    },

    /**
     * Schedules a draft, to go when the undo window that opens `now` closes, or at `at` if later.
     * Sending a draft that is already on its way returns that send. A failed one starts over.
     */
    send(draft: MessageRef, messageId: string, now: string, at?: string): Outgoing {
      const held = all().find((entry) => sameRef(entry.draft, draft));
      if (held && held.state !== 'failed') return held;
      const scheduled = outbox.schedule(
        { id: held?.id ?? crypto.randomUUID(), draft, messageId },
        now,
        at,
      );
      put(scheduled);
      changed();
      return scheduled;
    },

    /** Undo: the send is gone and its draft, untouched, is returned. */
    cancel(id: string): MessageRef {
      const draft = outbox.cancel(owned(id));
      sql.run(`DELETE FROM outbox WHERE id = ?`, id);
      changed();
      return draft;
    },

    /** The member's Retry. */
    retry(id: string, now: string): Outgoing {
      const retried = outbox.retry(owned(id), now);
      put(retried);
      changed();
      return retried;
    },

    /** Whether a draft is on its way, so nothing may replace it until the send is undone. */
    holds(draft: MessageRef): boolean {
      return all().some((entry) => sameRef(entry.draft, draft) && entry.state !== 'failed');
    },

    /**
     * Undoes a failed send of a draft the member has since changed. That draft is gone, so the
     * send has nothing left to send, and the changed draft is sent anew.
     */
    release(draft: MessageRef) {
      const failed = all().filter(
        (entry) => sameRef(entry.draft, draft) && entry.state === 'failed',
      );
      for (const { id } of failed) sql.run(`DELETE FROM outbox WHERE id = ?`, id);
      if (failed.length) changed();
    },

    /** Forgets an account's sends, as removing the account does. */
    forget(account: AccountId) {
      sql.run(`DELETE FROM outbox WHERE account = ?`, account);
      changed();
    },

    /** Holds a send this Mailroom finds mid-submit, which a restart cut short. */
    recover() {
      const before = all();
      const after = outbox.recover(before);
      const held = after.filter((entry, at) => entry !== before[at]);
      for (const entry of held) put(entry);
      if (held.length) changed();
    },

    /** When the Outbox next needs a wake, in milliseconds since the epoch. */
    nextWake(): number | undefined {
      const at = outbox.nextWake(all());
      return at === undefined ? undefined : Date.parse(at);
    },

    /**
     * Runs the steps due now, soonest first, up to a wake's budget, reading the Outbox again
     * before each, since a command may have undone or retried a send meanwhile. Returns how many
     * steps it ran. One run at a time.
     */
    async run(now: () => string, budget = WAKE.steps): Promise<number> {
      if (running) return 0;
      running = true;
      let steps = 0;
      try {
        for (; steps < budget; steps++) {
          const [next] = outbox.due(all(), now());
          if (!next) break;
          await step(next, now);
        }
      } finally {
        running = false;
      }
      return steps;
    },
  };
}

/** A step's outcome, or how it failed. Anything but a `SendFailure` waits for the member. */
async function attempt<T>(work: () => Promise<T>): Promise<T | outbox.Failure> {
  try {
    return await work();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: reason, passing: error instanceof SendFailure && error.passing };
  }
}

const sameRef = (a: MessageRef, b: MessageRef) =>
  a.account === b.account &&
  a.path === b.path &&
  a.uidValidity === b.uidValidity &&
  a.uid === b.uid;
