import * as signing from '../../accounts/core/index.ts';
import { listed, type Account, type AccountId, type Hint } from '../../mail/core/index.ts';
import {
  PRESETS,
  codeFrom,
  codeRequest,
  isFresh,
  pollRequest,
  polled,
  refreshRequest,
  refreshed,
  withStandIn,
  type Client,
  type DeviceSignIn,
  type Polled,
  type Preset,
  type PresetName,
  type Tokens,
  type VendorAnswer,
  type VendorRequest,
} from '../../providers/index.ts';
import type { SignIn, SignInPreset, SignInSetup } from '../client/contract.ts';
import { connectionOf, type AccountBook } from './accounts.ts';
import { deviceOf, type Connections } from './connections.ts';
import type { Credentials } from './credentials.ts';
import { report } from './report.ts';
import type { Sql } from './schema.ts';

/**
 * Signing in at a vendor, for accounts that sign in there instead of with a password. A sign-in
 * starts with a code the member enters on the vendor's page, and the wake polls the vendor until
 * they approve it. Once both hosts take its token, the account is added, or reconnected if it was
 * signing in again. Each account's access token is then kept in memory while it's fresh, and its
 * refresh token sealed beside the account.
 */
export type SigningIn = ReturnType<typeof signingIn>;

/**
 * Where each preset that can sign in finds the operator's app in the Worker's settings, and a test's
 * stand-in for its vendor.
 */
const APPS = {
  outlook: { id: 'MICROSOFT_CLIENT_ID', standIn: 'OUTLOOK_STAND_IN' },
} as const satisfies Record<SignInPreset, { id: string; standIn: string }>;

/** The Worker's settings that signing in reads, as `APPS` names them. */
export type AppSettings = Partial<Record<(typeof APPS)[SignInPreset]['id' | 'standIn'], string>>;

/** How long a vendor has to answer one request of a sign-in. */
const VENDOR_PATIENCE_MS = 15_000;

export function signingIn(ports: {
  sql: Sql;
  book: AccountBook;
  credentials: Credentials;
  settings: AppSettings;
  /** Whether this deployment holds the demo mailbox, and so can never reach a real account. */
  isDemo: boolean;
  checkSignIn: Connections['checkSignIn'];
  /** Forgets what an account owes and closes its provider. */
  disconnect: (account: AccountId) => Promise<void>;
  unwatch: (account: AccountId) => void;
  setStatus: (account: AccountId, status: Account['status']) => void;
  hint: (hint: Hint) => void;
  /** Owes an account a check, and has the next wake land it at once. */
  check: (account: AccountId) => Promise<void>;
  wakeBy: (at: number) => Promise<void>;
}) {
  const { book, credentials, hint } = ports;
  /** Sign-ins at a vendor while members enter their codes. */
  const underWay = signInBook(ports.sql);
  /** Each signed-in account's access token while it's fresh. Only memory holds them. */
  const tokens = new Map<AccountId, Tokens>();
  /** A refresh under way per account, so connections opening at once share it. */
  const refreshing = new Map<AccountId, Promise<Tokens>>();

  /** A preset, with a test's stand-ins for its vendor when the test gave them. */
  const presetNamed = (name: PresetName): Preset => {
    const app = name in APPS ? APPS[name as SignInPreset] : undefined;
    return withStandIn(PRESETS[name], app && ports.settings[app.standIn]);
  };

  /** The preset's sign-in, and the operator's app at its vendor, if this deployment has one. */
  const vendor = (
    preset: PresetName | undefined,
  ): { signIn: DeviceSignIn; client: Client } | undefined => {
    const device = preset && presetNamed(preset).device;
    if (ports.isDemo || !preset || !device || !(preset in APPS)) return undefined;
    const id = ports.settings[APPS[preset as SignInPreset].id];
    return id ? { signIn: device, client: { id } } : undefined;
  };

  /** The preset a sign-in is for: the new account's, or that of the account signing in again. */
  const presetOf = (pending: signing.Pending): PresetName | undefined =>
    'account' in pending.to ? book.get(pending.to.account)?.account.preset : pending.to.preset;

  /** Stores where a sign-in moved on to, and tells devices when they'd see a change. */
  const movedOn = (pending: signing.Pending, seen = true) => {
    underWay.update(pending);
    if (seen) hint({ changed: 'accounts' });
  };

  /** How a new account is reached: its preset's hosts, or a test's stand-ins for them. */
  const connectionFor = (pending: signing.Pending) => {
    const { preset } = pending.to as signing.NewAccount;
    const { imap, smtp } = presetNamed(preset);
    return connectionOf({ address: pending.address, preset, imap, smtp });
  };

  /**
   * Finishes a sign-in the vendor approved: signs in to both hosts with the token first, as a
   * password is checked, then adds the account or reconnects the one signing in again. If either
   * host refuses, the tokens go and only the reason stays.
   */
  const finish = async (pending: signing.Pending, granted: Tokens, signIn: DeviceSignIn) => {
    const stop = (reason: string) => movedOn(signing.refused(pending, reason, Date.now()));
    const { address } = pending;
    const held = 'account' in pending.to ? book.get(pending.to.account) : undefined;
    if ('account' in pending.to && held?.connection.provider !== 'imap') {
      return stop('That account was removed before the sign-in finished.');
    }
    const id = held?.account.id ?? crypto.randomUUID();
    const connection =
      held?.connection.provider === 'imap' ? held.connection : connectionFor(pending);
    const accessToken = () => Promise.resolve(granted.access);
    try {
      await ports.checkSignIn(id, connection, { accessToken });
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      return stop(signIn.whenRefused ? `${said} ${signIn.whenRefused}` : said);
    }
    const sealed = await credentials.seal(granted.refresh, id);
    if (held) {
      await ports.disconnect(id);
      book.reseal(id, sealed);
      tokens.set(id, granted);
      ports.setStatus(id, 'syncing');
    } else {
      if (
        listed(
          address,
          book.all().map((account) => account.address),
        )
      ) {
        return stop(`${address} is already connected.`);
      }
      const { name, fromName, preset } = pending.to as signing.NewAccount;
      book.add(
        { id, name, address, ...(fromName ? { fromName } : {}), provider: 'imap', preset },
        connection,
        { sealed },
      );
      tokens.set(id, granted);
    }
    underWay.finish(pending);
    hint({ changed: 'accounts' });
    await ports.check(id);
  };

  const pollOne = async (pending: signing.Pending) => {
    const found = vendor(presetOf(pending));
    const sealed = underWay.sealed(pending.address);
    if (!found || !sealed) {
      movedOn(signing.refused(pending, notSetUp(presetOf(pending)), Date.now()));
      return;
    }
    const deviceCode = await credentials.open(sealed, deviceCodeOf(pending.address));
    const { signIn, client } = found;
    let result: Polled;
    try {
      const answer = await ask(pollRequest(signIn, client, deviceCode));
      result = polled(signIn, answer, pending.interval, Date.now());
    } catch (error) {
      // A vendor out of reach is asked again after the interval, until the code expires.
      report(error);
      result = { pending: pending.interval };
    }
    const next = signing.polled(pending, result, Date.now());
    movedOn(next, next.state !== pending.state);
    if ('granted' in result) await finish(next, result.granted, signIn);
  };

  /**
   * A new access token from the account's refresh token, at the accounts server it signed in at.
   * A refresh token the vendor replaces is stored before the new access token is used. One the
   * vendor refuses for good leaves the account waiting for its member, and nothing asks again.
   */
  const refresh = async (account: AccountId): Promise<Tokens> => {
    const held = book.get(account);
    if (!held) throw new Error('There is no such account.');
    if (held.account.status === 'needs-sign-in') throw new Error(lapsed(held.account));
    const found = vendor(held.account.preset);
    const sealed = book.sealed(account);
    if (!found || !sealed) throw new Error(notSetUp(held.account.preset));
    const kept = await credentials.open(sealed, account);
    const answer = await ask(refreshRequest(found.signIn, found.client, kept));
    const result = refreshed(found.signIn, answer, kept, Date.now());
    if ('lapsed' in result) {
      report(result.lapsed);
      tokens.delete(account);
      ports.unwatch(account);
      ports.setStatus(account, 'needs-sign-in');
      throw new Error(lapsed(held.account));
    }
    if ('failed' in result) throw new Error(result.failed);
    if (result.granted.refresh !== kept) {
      book.reseal(account, await credentials.seal(result.granted.refresh, account));
    }
    tokens.set(account, result.granted);
    return result.granted;
  };

  return {
    /**
     * Starts a sign-in at the preset's vendor, for a new account or for one that needs signing in
     * again. The wake polls it from here.
     */
    async start(to: SignInSetup | AccountId): Promise<SignIn> {
      if (ports.isDemo) throw new Error(signing.DEMO_SAID);
      let address: string;
      let preset: PresetName | undefined;
      let pendingTo: signing.Pending['to'];
      if (typeof to === 'string') {
        const held = book.get(to)?.account;
        if (!held) throw new Error('There is no such account.');
        ({ address, preset } = held);
        pendingTo = { account: held.id };
      } else {
        ({ address, preset } = to);
        if (
          listed(
            address,
            book.all().map((account) => account.address),
          )
        ) {
          throw new Error(`${address} is already connected.`);
        }
        const { name, fromName } = to;
        pendingTo = { preset: to.preset, name, ...(fromName ? { fromName } : {}) };
      }
      const found = vendor(preset);
      if (!found) throw new Error(notSetUp(preset));

      const now = Date.now();
      const answer = await ask(codeRequest(found.signIn, found.client));
      const code = codeFrom(found.signIn, answer, now);
      const pending = signing.started(address, pendingTo, code, now);
      const sealed = await credentials.seal(code.deviceCode, deviceCodeOf(address));
      underWay.start(pending, sealed);
      hint({ changed: 'accounts' });
      await ports.wakeBy(pending.pollAt);
      return signInOf(pending);
    },

    /** Every sign-in under way, or stopped with a reason a member may still read. */
    list: (): SignIn[] => underWay.all(Date.now()).map(signInOf),

    /** The presets whose vendor this deployment can sign in at. */
    presets: (): SignInPreset[] =>
      (Object.keys(APPS) as SignInPreset[]).filter((preset) => vendor(preset)),

    preset: presetNamed,

    /** Polls each sign-in whose interval has passed, and stops each whose code has expired. */
    async poll() {
      for (const pending of underWay.all(Date.now())) {
        const need = signing.due(pending, Date.now());
        if (need === 'expire') movedOn(signing.expired(pending, Date.now()));
        else if (need === 'poll') await pollOne(pending).catch(report);
      }
    },

    /** When the next waiting sign-in needs a wake. */
    nextWake: (): number | undefined => signing.nextWake(underWay.all(Date.now())),

    /** An access token for an account that signs in at its vendor: the one held, or a fresh one. */
    async accessToken(account: AccountId): Promise<string> {
      const held = tokens.get(account);
      if (held && isFresh(held, Date.now())) return held.access;
      let asked = refreshing.get(account);
      if (!asked) {
        asked = refresh(account).finally(() => refreshing.delete(account));
        refreshing.set(account, asked);
      }
      return (await asked).access;
    },

    /** Stops each sign-in a restart cut short while its tokens were being checked, which it lost. */
    recover(now: number) {
      for (const pending of underWay.all(now)) {
        const recovered = signing.recover(pending, now);
        if (recovered !== pending) underWay.update(recovered);
      }
    },

    /** Forgets an account's sign-in and its token. */
    forget(account: AccountId) {
      underWay.forget(account);
      tokens.delete(account);
    },

    /** Forgets every token, as an erase does. */
    clear() {
      tokens.clear();
    },
  };
}

/** A request to a vendor, and its answer, within the vendor's patience. */
async function ask(request: VendorRequest): Promise<VendorAnswer> {
  const response = await fetch(request.url, {
    method: 'POST',
    body: request.form,
    signal: AbortSignal.timeout(VENDOR_PATIENCE_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** A sign-in as a browser sees it, without what only the Mailroom needs. */
function signInOf(pending: signing.Pending): SignIn {
  const seen = {
    address: pending.address,
    ...('account' in pending.to ? { account: pending.to.account } : {}),
    code: pending.code,
    link: pending.link,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
  return pending.state === 'refused'
    ? { ...seen, state: 'refused', reason: pending.reason }
    : { ...seen, state: pending.state };
}

/**
 * What a device code is sealed to: its address, apart from every account's id, so it can never be
 * opened as an account's secret.
 */
const deviceCodeOf = (address: string) => `sign-in:${address.toLowerCase()}`;

/** Why a preset can't sign in here. */
function notSetUp(preset: PresetName | undefined): string {
  const device = deviceOf(preset);
  if (!preset || !device || !(preset in APPS)) return 'That account doesn’t sign in at its vendor.';
  const { id } = APPS[preset as SignInPreset];
  return signing.signInNotSetUp(device.vendor, id);
}

/** What a member reads when an account's sign-in has lapsed. */
const lapsed = (account: Account) => `Sign in to ${account.name} again.`;

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
      .map((row) => JSON.parse(row.pending) as signing.Pending);
  const remove = (address: string) =>
    sql.run(`DELETE FROM sign_ins WHERE address = ?`, keyOf(address));

  return {
    /** Every sign-in still kept, and none of the rest, which go now. */
    all(now: number): signing.Pending[] {
      const held = rows();
      for (const gone of held.filter((pending) => !signing.kept(pending, now)))
        remove(gone.address);
      return held.filter((pending) => signing.kept(pending, now));
    },

    /** A new sign-in for its address, replacing any before it, with its sealed device code. */
    start(pending: signing.Pending, sealed: Uint8Array) {
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
    update(pending: signing.Pending) {
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
    finish(pending: signing.Pending) {
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
