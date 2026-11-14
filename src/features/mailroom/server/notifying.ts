import {
  refKey,
  type AccountId,
  type FolderRef,
  type Index,
  type Message,
  type MessageRef,
  type SyncEvent,
} from '../../mail/core/index.ts';
import {
  newsIn,
  noticesOf,
  pushOf,
  type Mark,
  type Subscription,
} from '../../notifications/core/index.ts';
import { deliver, pushKeyOf, type PushKey } from '../../notifications/server/index.ts';
import { report } from './report.ts';
import type { Sql } from './schema.ts';

export type Notifying = ReturnType<typeof notifying>;

/** How many refs of messages the member moved into an Inbox are held, oldest dropped first. */
const MOVED_IN_HELD = 1_000;

/**
 * Notifying a member's devices of new Inbox mail. It keeps each device they turned notifications
 * on for, by its push subscription, and how far each Inbox has been read for news. A wake's sync
 * notes the news in each batch it lands in an Inbox, and once the sync is done every notified
 * device is told it by Web Push.
 */
export function notifying(ports: {
  sql: Sql;
  reads: Pick<Index, 'role' | 'message'>;
  nameOf: (account: AccountId) => string | undefined;
  /**
   * The deployment's Web Push key, a P-256 private key in PKCS #8 PEM. With `OPERATOR_EMAIL`, whom
   * push services contact about its pushes, it turns notifications on.
   */
  settings: { PUSH_KEY?: string; OPERATOR_EMAIL?: string };
  /** Posts a push to its push service. */
  post: (request: Request) => Promise<Response>;
}) {
  const { sql } = ports;
  /** Messages the member moved into an Inbox, by ref, whose arrival there is no news. */
  const movedIn = new Set<string>();
  /** The news this wake's sync folded, told once the wake's sync is done. */
  let news: Message[] = [];
  let pushKey: Promise<PushKey | undefined> | undefined;

  /** Every notified device's subscription, the earliest turned on first. */
  const devices = (): Subscription[] =>
    sql
      .all<{ subscription: string }>(`SELECT subscription FROM devices ORDER BY added, endpoint`)
      .map(({ subscription }) => JSON.parse(subscription) as Subscription);

  const isAnyNotified = () => sql.all(`SELECT 1 FROM devices LIMIT 1`).length > 0;

  const forget = (endpoint: string) => sql.run(`DELETE FROM devices WHERE endpoint = ?`, endpoint);

  const setMark = ({ account, path }: FolderRef, mark: Mark) => {
    sql.run(
      `INSERT OR REPLACE INTO news_marks (account, path, mark) VALUES (?, ?, ?)`,
      account,
      path,
      JSON.stringify(mark),
    );
  };

  /**
   * The deployment's push key, or nothing where notifications are off. A key that can't be read is
   * reported, and leaves notifications off and everything else working.
   */
  const key = (): Promise<PushKey | undefined> => {
    const { PUSH_KEY: pem, OPERATOR_EMAIL: operator } = ports.settings;
    pushKey ??=
      pem && operator
        ? pushKeyOf(pem, operator).catch((error: unknown) => {
            report(error);
            return undefined;
          })
        : Promise.resolve(undefined);
    return pushKey;
  };

  return {
    /** Whether any device is notified, so the Mailroom checks mail sooner. */
    isAnyNotified,

    isNotified: (endpoint: string) =>
      sql.all(`SELECT 1 FROM devices WHERE endpoint = ?`, endpoint).length > 0,

    /** The key a device subscribes with, or nothing where notifications are off. */
    async publicKey(): Promise<string | undefined> {
      return (await key())?.publicKey;
    },

    /** Notifies a device from now on. Subscribing again replaces its keys. */
    async notify(subscription: Subscription, at: number) {
      if (!(await key())) throw new Error('Notifications aren’t set up on this Trail Mix.');
      sql.run(
        `INSERT OR REPLACE INTO devices (endpoint, subscription, added) VALUES (?, ?, ?)`,
        subscription.endpoint,
        JSON.stringify(subscription),
        at,
      );
    },

    forget,

    /** Forgets an account's marks, as it goes. */
    forgetAccount: (account: AccountId) =>
      sql.run(`DELETE FROM news_marks WHERE account = ?`, account),

    /** A message the member moved, which isn't news if its move lands it in an Inbox. */
    movedIn(ref: MessageRef) {
      movedIn.add(refKey(ref));
      for (const oldest of movedIn) {
        if (movedIn.size <= MOVED_IN_HELD) break;
        movedIn.delete(oldest);
      }
    },

    /**
     * Notes the news in a batch an Inbox's sync landed, to tell once the wake's sync is done, and
     * moves the Inbox's mark on. Marks move whether or not a device is notified, so turning
     * notifications on finds every Inbox already read.
     */
    note(folder: FolderRef, events: readonly SyncEvent[]) {
      if (ports.reads.role(folder) !== 'inbox') return;
      const [row] = sql.all<{ mark: string }>(
        `SELECT mark FROM news_marks WHERE account = ? AND path = ?`,
        folder.account,
        folder.path,
      );
      const held = row && (JSON.parse(row.mark) as Mark);
      const { news: found, mark } = newsIn(events, held, {
        now: Date.now(),
        movedIn: (ref) => movedIn.delete(refKey(ref)),
      });
      if (mark && (mark.uid !== held?.uid || mark.uidValidity !== held.uidValidity)) {
        setMark(folder, mark);
      }
      if (found.length === 0 || !isAnyNotified()) return;
      for (const envelope of found) {
        const message = ports.reads.message(envelope);
        if (message) news.push(message);
      }
    },

    /**
     * Tells every notified device the news this wake's sync folded. A device whose subscription
     * has ended is forgotten. A push that fails costs that notice and nothing more, and never the
     * wake.
     */
    async tell() {
      const told = news;
      news = [];
      const pushing = told.length > 0 ? await key() : undefined;
      if (!pushing) return;
      const notices = noticesOf(told, ports.nameOf);
      for (const device of devices()) {
        try {
          for (const notice of notices) {
            const fared = await deliver(device, pushOf(notice), pushing, ports.post);
            if (fared === 'gone') {
              forget(device.endpoint);
              break;
            }
            if (fared === 'refused') {
              report(new Error('A push service refused this deployment’s key.'));
            }
          }
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
