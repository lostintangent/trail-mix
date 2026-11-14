import { DEMO_SAID } from '../../accounts/core/index.ts';
import type { Account, AccountId, Hint, StampColor } from '../../mail/core/index.ts';
import {
  DEMO_ACCOUNTS,
  PRESETS,
  demoMailbox,
  type DemoKind,
  type DemoMailbox,
  type Endpoint,
  type PresetName,
  type SyncWindow,
} from '../../providers/index.ts';
import type { AccountSetup } from '../client/contract.ts';
import type { Credentials } from './credentials.ts';
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

/**
 * How an account that signs in with a password is reached: through the endpoints it was given, or
 * else its preset's. Quirks always come from the preset.
 */
export function connectionOf(setup: {
  address: string;
  preset?: PresetName;
  imap?: Endpoint;
  smtp?: Endpoint;
}): Extract<Connection, { provider: 'imap' }> {
  const preset = setup.preset && PRESETS[setup.preset];
  const imap = setup.imap ?? preset?.imap;
  const smtp = setup.smtp ?? preset?.smtp;
  if (!imap || !smtp) throw new TypeError('Without a preset, both hosts are needed.');
  return {
    provider: 'imap',
    imap,
    smtp,
    user: setup.address,
    filesSent: preset?.filesSent ?? false,
  };
}

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
      account: Omit<Account, 'stamp' | 'status' | 'allowImagesFrom' | 'lightPaperFrom'>,
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
          lightPaperFrom: [],
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

    /** Replaces an account's sealed secret, as a vendor's sign-in gives a new refresh token. */
    reseal(id: AccountId, sealed: Uint8Array) {
      sql.run(`UPDATE credentials SET sealed = ? WHERE account = ?`, sealed, id);
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

/**
 * What a member does with the accounts they connect: adding one, whose password both its hosts
 * take before anything of it is kept, or one of the demo's, and changing what they see of each.
 */
export type ConnectedAccounts = ReturnType<typeof connectedAccounts>;

/** How far back mail is indexed. Older mail stays on the server. */
const WINDOW_DAYS = 365;

export function connectedAccounts(ports: {
  book: AccountBook;
  credentials: Credentials;
  demo: DemoSettings | undefined;
  /** Signs in to both of an account's hosts with its password, or rejects with the host's reason. */
  checkSignIn: (
    account: AccountId,
    connection: Extract<Connection, { provider: 'imap' }>,
    secret: { pass: string },
  ) => Promise<void>;
  hint: (hint: Hint) => void;
  /** Owes an account a check, and has the next wake land it at once. */
  check: (account: AccountId) => Promise<void>;
}) {
  const { book, hint } = ports;

  /** Adds the first demo account not yet here, Personal and then Work. */
  const addDemo = (): Account => {
    if (!ports.demo) throw new Error('This deployment has no demo mailbox.');
    const { inbox: size, createdAt = new Date().toISOString() } = ports.demo;
    const here = new Set(
      book
        .connections()
        .flatMap(({ connection }) => (connection.provider === 'demo' ? [connection.kind] : [])),
    );
    const kind = (Object.keys(DEMO_ACCOUNTS) as DemoKind[]).find((held) => !here.has(held));
    if (!kind) throw new Error('Both demo accounts are already here.');
    const { name, me } = DEMO_ACCOUNTS[kind];
    const inbox = kind === 'personal' ? size : Math.ceil(size / 10);
    return book.add(
      {
        id: crypto.randomUUID(),
        name,
        address: me.email,
        ...(me.name ? { fromName: me.name } : {}),
        provider: 'demo',
      },
      { provider: 'demo', kind },
      { demo: demoMailbox(kind, inbox, createdAt) },
    );
  };

  /** Changes an account as `change` says, and tells every device. */
  const updated = (id: AccountId, change: (account: Account) => Account) => {
    if (!book.update(id, change)) throw new Error('There is no such account.');
    hint({ changed: 'accounts' });
  };

  return {
    async add(setup: AccountSetup): Promise<Account> {
      if (setup.provider === 'demo') {
        const account = addDemo();
        hint({ changed: 'accounts' });
        await ports.check(account.id);
        return account;
      }
      // Preview and demo deployments hold the demo mailbox, and can never reach a real account.
      if (ports.demo) throw new Error(DEMO_SAID);
      if (!('password' in setup)) throw new Error('Outlook sign-in arrives with its own step.');
      const address = setup.address.toLowerCase();
      if (book.all().some((held) => held.address.toLowerCase() === address)) {
        throw new Error(`${setup.address} is already connected.`);
      }
      const connection = connectionOf(setup);

      // Nothing is kept until both hosts accept the password.
      const id = crypto.randomUUID();
      await ports.checkSignIn(id, connection, { pass: setup.password });

      const account = book.add(
        {
          id,
          name: setup.name,
          address: setup.address,
          ...(setup.fromName ? { fromName: setup.fromName } : {}),
          provider: 'imap',
          ...(setup.preset ? { preset: setup.preset } : {}),
        },
        connection,
        { sealed: await ports.credentials.seal(setup.password, id) },
      );
      hint({ changed: 'accounts' });
      await ports.check(id);
      return account;
    },

    addDemo,

    update(
      id: AccountId,
      change: Partial<Pick<Account, 'name' | 'fromName' | 'stamp' | 'signature'>>,
    ) {
      const { fromName, ...rest } = change;
      updated(id, ({ fromName: held, ...account }) => {
        const name = fromName ?? held;
        return { ...account, ...rest, ...(name ? { fromName: name } : {}) };
      });
    },

    allowImages(account: AccountId, sender: string) {
      updated(account, (held) =>
        held.allowImagesFrom.includes(sender)
          ? held
          : { ...held, allowImagesFrom: [...held.allowImagesFrom, sender] },
      );
    },

    setLightPaper(account: AccountId, sender: string, on: boolean) {
      updated(account, (held) => {
        const others = held.lightPaperFrom.filter((each) => each !== sender);
        return { ...held, lightPaperFrom: on ? [...others, sender] : others };
      });
    },

    /** Says how an account is doing, telling devices only when it changes. */
    setStatus(account: AccountId, status: Account['status']) {
      const before = book.get(account)?.account.status;
      if (before === undefined || before === status) return;
      book.update(account, (held) => ({ ...held, status }));
      hint({ changed: 'accounts' });
    },

    /** What the index holds of an account: its last year, or a demo mailbox's year before it was made. */
    windowOf(account: AccountId): SyncWindow {
      const until = book.demo(account)?.createdAt ?? new Date().toISOString();
      return { since: new Date(Date.parse(until) - WINDOW_DAYS * 86_400_000).toISOString() };
    },
  };
}

/**
 * The demo mailbox a deployment offers: the size of Personal's Inbox, when it was made, and whether
 * its mail server files its own copy of what it accepts in Sent, as Zoho's does.
 */
export type DemoSettings = { inbox: number; createdAt?: string; hostFilesSent?: true };

/**
 * Reads `DEMO_MAILBOX`, `DEMO_MAILBOX_AT` and `DEMO_HOST_FILES_SENT`, refusing anything else, so a
 * deployment set up wrong says so when its Mailroom starts rather than showing the wrong mail.
 * Without `DEMO_MAILBOX` there is no demo. `DEMO_MAILBOX_AT` is an ISO 8601 instant, with its
 * offset, and `DEMO_HOST_FILES_SENT` is `true` or unset.
 */
export function demoSettings(
  size?: string,
  at?: string,
  hostFilesSent?: string,
): DemoSettings | undefined {
  if (!size) {
    if (at) throw new Error('DEMO_MAILBOX_AT dates the demo mailbox, so it needs DEMO_MAILBOX.');
    if (hostFilesSent) {
      throw new Error('DEMO_HOST_FILES_SENT changes the demo mailbox, so it needs DEMO_MAILBOX.');
    }
    return undefined;
  }
  if (!/^[1-9]\d{0,6}$/.test(size)) {
    throw new Error(`DEMO_MAILBOX must be a number of messages, not ${JSON.stringify(size)}.`);
  }
  if (hostFilesSent !== undefined && hostFilesSent !== 'true') {
    throw new Error(
      `DEMO_HOST_FILES_SENT must be true or unset, not ${JSON.stringify(hostFilesSent)}.`,
    );
  }
  const host = hostFilesSent ? { hostFilesSent: true as const } : {};
  if (!at) return { inbox: Number(size), ...host };
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(at)
    ? Date.parse(at)
    : Number.NaN;
  if (Number.isNaN(instant)) {
    throw new Error(
      `DEMO_MAILBOX_AT must be an ISO 8601 instant such as 2026-11-09T12:00:00Z, not ${JSON.stringify(at)}.`,
    );
  }
  return { inbox: Number(size), createdAt: new Date(instant).toISOString(), ...host };
}
