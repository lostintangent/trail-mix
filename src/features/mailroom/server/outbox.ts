import {
  sameRef,
  type AccountId,
  type Hint,
  type MessageRef,
  type Outgoing,
} from '../../mail/core/index.ts';
import * as outbox from '../../outbox/core/index.ts';
import { SendFailure, type MailProvider } from '../../providers/index.ts';
import type { LastUpload } from '../client/contract.ts';
import type { AccountBook } from './accounts.ts';
import type { FiledDraft, SaveRequest, SavingDrafts } from './drafts.ts';
import type { EnvelopeIndex } from './envelope-index.ts';
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
  /** Lets a send go, noting what came of it for the presses that scheduled it. */
  const came = (send: string, what: Came) => {
    sql.run(`UPDATE presses SET came = ? WHERE send = ?`, JSON.stringify(what), send);
    sql.run(`DELETE FROM outbox WHERE id = ?`, send);
  };
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
     * at `at` if later, as the press `id` names, unless another send has that id. Sending a draft
     * that is already on its way returns that send, as it was scheduled. A failed one starts over.
     * A press that has come to something already answers with that, so one undone while it was
     * taken is never sent.
     */
    send(
      draft: Pick<Outgoing, 'draft' | 'messageId' | 'to' | 'subject'>,
      now: string,
      at: string | undefined,
      opened: string,
      id: string,
    ): Outgoing {
      const was = pressed(id);
      if (was?.send) return was.send;
      if (was?.came) {
        if ('sent' in was.came) return was.came.sent;
        throw new Error('The send was undone.');
      }
      const held = all().find((entry) => sameRef(entry.draft, draft.draft));
      // An id another send already has never takes its place.
      const named = get(id) ? crypto.randomUUID() : id;
      const outgoing =
        held && held.state !== 'failed'
          ? held
          : outbox.schedule({ id: held?.id ?? named, ...draft }, now, at, opened);
      sql.run(
        `INSERT INTO presses (id, at, send) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET send = excluded.send`,
        id,
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
      for (const { id } of failed) came(id, { undone: null });
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
     * comes after sync, rather than each waiting out the same host. One run at a time.
     */
    async run(now: () => string): Promise<void> {
      if (running) return;
      running = true;
      sql.run(
        `DELETE FROM presses WHERE at < ? AND (send IS NULL OR send NOT IN (SELECT id FROM outbox))`,
        Date.parse(now()) - outbox.PRESS_KEPT_MS,
      );
      const resting = new Set<AccountId>();
      try {
        for (let steps = 0; steps < WAKE.steps; steps++) {
          const [next] = outbox
            .due(all(), now())
            .filter(({ outgoing }) => !resting.has(outgoing.draft.account));
          if (!next) break;
          if (await step(next, now)) resting.add(next.outgoing.draft.account);
        }
      } finally {
        running = false;
      }
    },
  };
}

/** A send whose last save is being filed. Undo before its window closes keeps it as a draft. */
type Handing = {
  closes: number;
  isUndone: boolean;
  filing: Promise<FiledDraft>;
  sent: Promise<Outgoing>;
};

/**
 * The Outbox's commands as the member presses them, Send, Undo and Retry, each carried to the
 * queue, and the Outbox as a device lists it, each send placed in its conversation.
 */
export function outboxCommands(ports: {
  queue: OutboxQueue;
  drafts: Pick<SavingDrafts, 'file' | 'keep' | 'addressing'>;
  book: Pick<AccountBook, 'get'>;
  store: EnvelopeIndex;
  /** Has the Mailroom wake by then, to send what is due. */
  wakeBy: (at: number) => Promise<void>;
}) {
  const { queue, drafts, store } = ports;
  /** Sends whose last save is being filed, by the press that named them. Memory alone holds them. */
  const handing = new Map<string, Handing>();

  /** A send with the conversation its draft is in, as the index knows it now. */
  const placed = (outgoing: Outgoing): Outgoing => {
    const conversation = store.reads.message(outgoing.draft)?.conversation;
    return conversation === undefined ? outgoing : { ...outgoing, conversation };
  };

  /** Files a send's last save, then schedules the draft it made, unless the send was undone. */
  const sendLastSave = (
    { save, replaces }: LastUpload,
    when: string | undefined,
    opened: string,
    press: SaveRequest,
  ): Promise<Outgoing> => {
    const { id } = press;
    const filing = drafts.file(save, replaces, press);
    const entry = {
      closes: outbox.closesAfterPress(Date.parse(opened), when),
      isUndone: false,
      filing,
    };
    const sent = (async () => {
      const filed = await filing.catch((error: unknown) => {
        queue.unpress(id);
        throw error;
      });
      if (entry.isUndone) {
        queue.undone(id, new Date().toISOString(), filed.saved);
        await drafts.keep(filed);
        throw new Error('The send was undone.');
      }
      // Scheduled before the save owes its sync, so the sync never finds the draft unsent.
      const outgoing = queue.send(
        { draft: filed.saved, ...filed.addressing },
        new Date().toISOString(),
        when,
        opened,
        id,
      );
      await drafts.keep(filed);
      await ports.wakeBy(Date.parse(outgoing.sendAt));
      return placed(outgoing);
    })().finally(() => handing.delete(id));
    handing.set(id, Object.assign(entry, { sent }));
    return sent;
  };

  return {
    /** The Outbox as a device lists it. */
    list(): Outgoing[] {
      return queue.list().map((outgoing) => placed(outgoing));
    },

    /**
     * Schedules a draft to send when the undo window closes, or at a later time. The draft stays
     * in Drafts, as it is, until the host accepts it. The window opened when the member pressed
     * Send, `ago` milliseconds before the device asked, counted from when the request `arrived` at
     * the Worker, and never further back than its own length.
     *
     * Send may carry the message's last save in place of a draft, which is filed first, so a
     * device that closes once it has asked still sends. `press` names it, which the Outbox keeps
     * for a week, so asking again answers as the first ask did: with the send, as it stands or as
     * it went, or refused once it was undone. A press older than that is refused, since it may
     * have gone. A press a restart cut short may have filed its save, so its second ask looks for
     * that draft first.
     */
    async send(
      sent: MessageRef | LastUpload,
      when: string | undefined,
      ago: number,
      press: string,
      arrived: number,
    ): Promise<Outgoing> {
      const opened = new Date(arrived - Math.min(ago, outbox.UNDO_SECONDS * 1000)).toISOString();
      const held = handing.get(press);
      if (held) return held.sent;
      const known = queue.pressed(press);
      if (known?.send) return placed(known.send);
      if (known?.came) {
        if ('sent' in known.came) return placed(known.came.sent);
        throw new Error('The send was undone.');
      }
      outbox.checkPress(ago, known !== undefined);
      queue.press(press, new Date(arrived).toISOString());
      if ('save' in sent) {
        return sendLastSave(sent, when, opened, {
          id: press,
          mayBeFiled: known !== undefined,
          isPress: true,
        });
      }
      try {
        if (!ports.book.get(sent.account)) throw new Error('There is no such account.');
        if (store.reads.role(sent) !== 'drafts') throw new Error('Only a draft can be sent.');
        const addressing = await drafts.addressing(sent);
        const outgoing = queue.send(
          { draft: sent, ...addressing },
          new Date().toISOString(),
          when,
          opened,
          press,
        );
        await ports.wakeBy(Date.parse(outgoing.sendAt));
        return placed(outgoing);
      } catch (error) {
        queue.unpress(press);
        throw error;
      }
    },

    /**
     * Undo, for a press or the send it scheduled. A send whose last save is still being filed is
     * never scheduled, and its draft is returned once it is saved, while its window is open. A
     * press the Mailroom has yet to take never will be, and returns no draft. Asked again, it
     * answers as it did.
     */
    async undo(press: string): Promise<MessageRef | undefined> {
      const now = new Date().toISOString();
      const known = queue.pressed(press);
      if (known?.send) return queue.cancel(known.send.id, now);
      const held = handing.get(press);
      if (held) {
        if (Date.now() >= held.closes) throw new Error('It is being sent, so it can’t be undone.');
        held.isUndone = true;
        return (await held.filing).saved;
      }
      if (known?.came) {
        if ('sent' in known.came) throw new Error('It has been sent.');
        return known.came.undone ?? undefined;
      }
      queue.undone(press, now);
      return undefined;
    },

    /** The member's Retry of a send that failed, by its id. */
    async retry(id: string): Promise<Outgoing> {
      const retried = queue.retry(id, new Date().toISOString());
      await ports.wakeBy(Date.parse(retried.sendAt));
      return placed(retried);
    },

    /** Whether the member has undone a send whose last save is being filed. */
    isUndoing(press: string): boolean {
      return handing.get(press)?.isUndone === true;
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
