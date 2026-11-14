import type { AccountId } from '../../mail/core/index.ts';
import {
  DEMO_SIGNERS,
  PRESETS,
  authServersFor,
  demoServer,
  type DemoServer,
  type DeviceSignIn,
  type ImapAccount,
  type MailProvider,
  type Network,
  type Preset,
  type PresetName,
  type imap,
} from '../../providers/index.ts';
import type { AccountBook, Connection, DemoSettings } from './accounts.ts';
import type { Credentials } from './credentials.ts';
import { report } from './report.ts';

/**
 * Reaching each account's mail server: one provider per account, made when it's first needed and
 * kept until the account disconnects, and the one check that a host takes an account's secret
 * before anything of it is kept.
 */
export type Connections = ReturnType<typeof connections>;

/**
 * The IMAP provider's code, and how the Mailroom reaches hosts with it: workerd's STARTTLS works
 * only on its own sockets. The Mailroom loads both when its isolate first needs them.
 */
export type ImapCode = { code: Awaited<ReturnType<typeof imap>>; network: Network };

/** A password, or what gives each connection an access token from the account's vendor. */
export type Secret = { pass: string } | { accessToken: () => Promise<string> };

type ImapConnection = Extract<Connection, { provider: 'imap' }>;

export function connections(ports: {
  book: AccountBook;
  credentials: Credentials;
  demo: DemoSettings | undefined;
  /** A test's names for the servers on this machine that sign Authentication-Results. */
  authServersStandIn: string | undefined;
  /** An access token for an account that signs in at its vendor. */
  accessToken: (account: AccountId) => Promise<string>;
  imapCode: () => Promise<ImapCode>;
  /** The provider an account is reached through, as it's made. */
  reached: (provider: MailProvider) => MailProvider;
}) {
  const { book, credentials } = ports;
  const providers = new Map<AccountId, Promise<MailProvider>>();
  /** The demo's world beyond each demo account's provider, made with it: its list servers. */
  const demoServers = new Map<AccountId, DemoServer>();

  /** The names whose Authentication-Results an account's mail is verified by. */
  const signersOf = (account: AccountId): readonly string[] => {
    const connection = book.get(account)?.connection;
    if (!connection) return [];
    if (connection.provider === 'demo') return DEMO_SIGNERS;
    return authServersFor(connection.imap.host, ports.authServersStandIn);
  };

  const imapOver = async (account: AccountId, connection: ImapConnection, secret: Secret) => {
    const { code, network } = await ports.imapCode();
    const authServers = signersOf(account);
    return code.imapProvider({ ...imapAccount(account, connection, secret), authServers }, network);
  };

  const make = async (account: AccountId): Promise<MailProvider> => {
    const connection = book.get(account)?.connection;
    if (connection?.provider === 'demo') {
      const mailbox = book.demo(account);
      if (!mailbox) throw new Error('There is no such account.');
      const demo = demoServer(account, mailbox, (next) => book.saveDemo(account, next), {
        filesSent: ports.demo?.hostFilesSent,
      });
      demoServers.set(account, demo);
      return demo.provider;
    }
    if (!connection) throw new Error('There is no such account.');
    if (deviceOf(book.get(account)?.account.preset)) {
      return imapOver(account, connection, { accessToken: () => ports.accessToken(account) });
    }
    const sealed = book.sealed(account);
    if (!sealed) throw new Error('There is no such account.');
    return imapOver(account, connection, { pass: await credentials.open(sealed, account) });
  };

  /** The provider an account is reached through, made once and shared by every call. */
  const provider = (account: AccountId): Promise<MailProvider> => {
    let made = providers.get(account);
    if (!made) {
      made = make(account).then((each) => ports.reached(each));
      providers.set(account, made);
      made.catch(() => providers.delete(account));
    }
    return made;
  };

  return {
    provider,
    signersOf,

    /**
     * The demo's list servers for a demo account, which its one-click unsubscribes post to, and
     * nothing for any other account.
     */
    async demoLists(account: AccountId): Promise<DemoServer | undefined> {
      if (book.get(account)?.connection.provider !== 'demo') return undefined;
      await provider(account);
      const lists = demoServers.get(account);
      if (!lists) throw new Error('There is no such account.');
      return lists;
    },

    /** Signs in to both of an account's hosts with its secret, or rejects with the host's reason. */
    async checkSignIn(account: AccountId, connection: ImapConnection, secret: Secret) {
      const { code, network } = await ports.imapCode();
      await code.checkSignIn(imapAccount(account, connection, secret), network);
    },

    /** Closes an account's provider, so the next call reaches its server anew. */
    async close(account: AccountId) {
      const provider = providers.get(account);
      providers.delete(account);
      demoServers.delete(account);
      const opened = await provider?.catch(() => undefined);
      await opened?.close().catch(report);
    },
  };
}

/** How a preset's accounts sign in at its vendor, if they do instead of with a password. */
export function deviceOf(preset: PresetName | undefined): DeviceSignIn | undefined {
  const held: Preset | undefined = preset && PRESETS[preset];
  return held?.device;
}

function imapAccount(account: AccountId, connection: ImapConnection, secret: Secret): ImapAccount {
  return {
    account,
    imap: connection.imap,
    smtp: connection.smtp,
    auth: { user: connection.user, ...secret },
    filesSent: connection.filesSent,
  };
}
