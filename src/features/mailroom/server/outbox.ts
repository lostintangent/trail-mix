import {
  sameRef,
  type AccountId,
  type Hint,
  type MessageRef,
  type Outgoing,
} from '../../mail/core/index.ts';
import * as outbox from '../../outbox/core/index.ts';
import { SendFailure, type MailProvider } from '../../providers/index.ts';
import type { Sql } from './schema.ts';
import { WAKE } from './sync.ts';

/**
 * The Outbox as the Mailroom keeps and drives it: the member's schedule of drafts to send, stored
 * one row per send, and carried through the Outbox's state machine by the alarm. Every change is
 * stored before the next step reaches a mail server, so a wake cut short anywhere resumes from the
 * last change, and every change hints the member's devices.
 *
 * It keeps each press of Send it has taken for a week, with the send the press scheduled and what
 * came of it, so a press asked again answers as its first ask did, and an Undo that comes before a
 * press keeps it from ever being sent. A send scheduled without a press is its own.
 *
 * A Mailroom calls `recover` once as it starts, before anything else can begin a send, so a send it
 * finds mid-submit was cut short by the restart.
 */
export type OutboxQueue = ReturnType<typeof outboxQueue>;

type Sending = {
  sql: Sql;
  provider: (account: AccountId) => Promise<MailProvider>;
  hint: (hint: Hint) => void;
  /** Hears that a send has left Drafts and has its copy in Sent, so those folders sync. */
  sent: (outgoing: Outgoing) => void;
  /** Runs once the host has accepted a message, before the Outbox records it. Tests stop here. */
  accepted?: () => void;
};

/** What came of a press: its send, as the host accepted it, or its Undo, with the draft it kept. */
type Came = { sent: Outgoing } | { undone: MessageRef | null };

/** A press the Mailroom has taken: its send, while the Outbox holds it, and what came of it. */
type Pressed = { send?: Outgoing; came?: Came };

/**
 * How long a press is kept from when it was taken, and for as long as its send waits after that, so
 * it answers alike when asked again.
 */
export const PRESS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** Notes what came of the presses that scheduled a send. */
  const came = (send: string, what: Came) =>
    sql.run(`UPDATE presses SET came = ? WHERE send = ?`, JSON.stringify(what), send);
  const pressed = (id: string): Pressed | undefined => {
    const [row] = sql.all<{ send: string | null; came: string | null }>(
      `SELECT send, came FROM presses WHERE id = ?`,
      id,
    );
    if (!row) return undefined;
    const send = row.send === null ? undefined : get(row.send);
    return {
      ...(send && { send }),
      ...(row.came !== null && { came: JSON.parse(row.came) as Came }),
    };
  };
  const owned = (id: string) => {
    const held = get(id);
    if (!held) throw new Error('There is no such send.');
    return held;
  };

  /**
   * Runs one step of a send, and stores what it came to, unless the send went while it ran. Says
   * whether the step failed for a passing reason, such as a host it couldn't reach.
   */
  async function step(due: outbox.Due, now: () => string): Promise<boolean> {
    const { id, draft, messageId } = due.outgoing;
    const provider = () => sending.provider(draft.account);
    const outcome =
      due.step === 'submit'
        ? await (async () => {
            put(outbox.begin(due.outgoing));
            changed();
            const submitted = await attempt(async () =>
              (await provider()).submit(draft, messageId),
            );
            if (submitted === 'sent') sending.accepted?.();
            return submitted;
          })()
        : await attempt(async () => (await provider()).file(draft, messageId, due.waitForHost));
    const held = get(id);
    if (!held) return false;
    if (due.step === 'submit') {
      put(outbox.submitted(held, outcome as outbox.Submitted, now()));
    } else {
      const result = outbox.filed(held, outcome as outbox.Filed, now());
      if (result === 'done') {
        came(id, { sent: held });
        sql.run(`DELETE FROM outbox WHERE id = ?`, id);
        sending.sent(due.outgoing);
      } else {
        put(result);
      }
    }
    changed();
    return typeof outcome === 'object' && outcome.passing;
  }

  return {
    /** Every send, soonest first. */
    list(): Outgoing[] {
      return all().toSorted((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id.localeCompare(b.id));
    },

    /**
     * Schedules a draft, to go when the undo window that opened at the press, `opened`, closes, or
     * at `at` if later, as the press `id` names, or a new one. Sending a draft that is already on
     * its way returns that send, as it was scheduled. A failed one starts over. A press that has
     * come to something already answers with that, so one undone while it was taken is never sent.
     */
    send(
      draft: Pick<Outgoing, 'draft' | 'messageId' | 'to' | 'subject'>,
      now: string,
      at?: string,
      opened?: string,
      id?: string,
    ): Outgoing {
      const was = id === undefined ? undefined : pressed(id);
      if (was?.send) return was.send;
      if (was?.came) {
        if ('sent' in was.came) return was.came.sent;
        throw new Error('The send was undone.');
      }
      const held = all().find((entry) => sameRef(entry.draft, draft.draft));
      // An id another send already has never takes its place.
      const named = id !== undefined && !get(id) ? id : undefined;
      const outgoing =
        held && held.state !== 'failed'
          ? held
          : outbox.schedule(
              { id: held?.id ?? named ?? crypto.randomUUID(), ...draft },
              now,
              at,
              opened,
            );
      sql.run(
        `INSERT INTO presses (id, at, send) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET send = excluded.send`,
        id ?? outgoing.id,
        Date.parse(now),
        outgoing.id,
      );
      if (outgoing !== held) {
        put(outgoing);
        changed();
      }
      return outgoing;
    },

    /** Undo: the send is gone and its draft, untouched, is returned. */
    cancel(id: string, now: string): MessageRef {
      const draft = outbox.cancel(owned(id), now);
      came(id, { undone: draft });
      sql.run(`DELETE FROM outbox WHERE id = ?`, id);
      changed();
      return draft;
    },

    /** A press, as the Mailroom has taken it, if it has. */
    pressed,

    /** Notes a press the Mailroom has begun to take, before it files or schedules anything. */
    press(id: string, now: string) {
      sql.run(`INSERT OR IGNORE INTO presses (id, at) VALUES (?, ?)`, id, Date.parse(now));
    },

    /** Forgets a press whose taking failed before it scheduled a send, so it may be asked again. */
    unpress(id: string) {
      sql.run(`DELETE FROM presses WHERE id = ? AND send IS NULL AND came IS NULL`, id);
    },

    /**
     * Notes a press undone before it scheduled a send, with the draft its last save left, so
     * nothing the press asks for is sent.
     */
    undone(id: string, now: string, draft?: MessageRef) {
      sql.run(
        `INSERT INTO presses (id, at, came) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET came = excluded.came`,
        id,
        Date.parse(now),
        JSON.stringify({ undone: draft ?? null } satisfies Came),
      );
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
      for (const { id } of failed) {
        came(id, { undone: null });
        sql.run(`DELETE FROM outbox WHERE id = ?`, id);
      }
      if (failed.length) changed();
    },

    /** Forgets an account's sends, as removing the account does, which undoes their presses. */
    forget(account: AccountId) {
      sql.run(
        `UPDATE presses SET came = ? WHERE send IN (SELECT id FROM outbox WHERE account = ?)`,
        JSON.stringify({ undone: null } satisfies Came),
        account,
      );
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
     * before each, since a command may have undone or retried a send meanwhile. Once an account's
     * host fails for a passing reason, the account's other sends wait for the next wake, which
     * comes after sync, rather than each waiting out the same host. Returns how many steps it ran.
     * One run at a time.
     */
    async run(now: () => string, budget = WAKE.steps): Promise<number> {
      if (running) return 0;
      running = true;
      sql.run(
        `DELETE FROM presses WHERE at < ? AND (send IS NULL OR send NOT IN (SELECT id FROM outbox))`,
        Date.parse(now()) - PRESS_KEPT_MS,
      );
      let steps = 0;
      const resting = new Set<AccountId>();
      try {
        for (; steps < budget; steps++) {
          const [next] = outbox
            .due(all(), now())
            .filter(({ outgoing }) => !resting.has(outgoing.draft.account));
          if (!next) break;
          if (await step(next, now)) resting.add(next.outgoing.draft.account);
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
