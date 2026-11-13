import { COMMANDS, QUERIES, receivedCall } from '../client/contract.ts';
import { HOST_FILING_SECONDS } from '../../outbox/core/index.ts';
import type { MailProvider, Preset, PresetName } from '../../providers/index.ts';
import { Mailroom, type MailroomEnv } from './mailroom.ts';
import { REREAD } from './schema.ts';

/**
 * The Mailroom on workerd, for tests. A path's first segment names the member, standing in for the
 * Worker's sign-in, which `src/server` proves. `POST /<member>/call` runs a query or command,
 * `/<member>/updates` opens the hint socket, and the subclass adds what a test needs to look inside.
 */
export class TestMailroom extends Mailroom {
  private readonly wakes: Wake[] = [];

  /** Set while a test holds wakes back, and resolved when it lets them go. */
  private held: { wakes: Promise<void>; release: () => void } | undefined;

  /** Holds every wake back until `releaseWakes`, so nothing a command owes lands meanwhile. */
  holdWakes(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.held = { wakes: promise, release: resolve };
    return Promise.resolve();
  }

  releaseWakes(): Promise<void> {
    this.held?.release();
    this.held = undefined;
    return Promise.resolve();
  }

  /** Records each wake that landed anything, with each account's status and indexed mail after it. */
  protected override async wake(): Promise<number> {
    await this.held?.wakes;
    const steps = await super.wake();
    if (steps === 0) return steps;
    const accounts = await this.accounts();
    this.wakes.push({
      steps,
      accounts: accounts.map(({ id, name, status }) => ({
        name,
        status,
        messages: this.sql.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM messages WHERE account = ?`,
          id,
        )[0]!.n,
      })),
    });
    return steps;
  }

  wakeLog(): Promise<Wake[]> {
    return Promise.resolve(this.wakes);
  }

  /** Has the member last opened this Mailroom `days` ago, as if no device had asked since. */
  unopenedFor(days: number): Promise<void> {
    this.writeOpened(Date.now() - days * 24 * 60 * 60_000);
    return Promise.resolve();
  }

  /** When storage says a signed-in device last asked this Mailroom for something. */
  lastOpened(): Promise<number | undefined> {
    return Promise.resolve(this.sql.all<{ at: number }>(`SELECT at FROM opened`)[0]?.at);
  }

  /** When the alarm next comes, if it is set. */
  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** One wake now, as the alarm runs it: the steps it landed, and when the next alarm comes. */
  async wakeNow(): Promise<{ steps: number; alarm: number | null; openedAt: number }> {
    const steps = await this.wake();
    return { steps, alarm: await this.ctx.storage.getAlarm(), openedAt: this.openedAt };
  }

  /** Ends this instance, as a deploy or an eviction would. The next request starts a new one. */
  restart(): Promise<void> {
    this.ctx.abort('A test restarted the Mailroom.');
    return Promise.resolve();
  }

  /**
   * Has the index hold its mail as a release from before verified senders and readable previews
   * did: no sender verified, a preview that reads `as before`, and no row naming an avatar.
   */
  indexAsBefore(): Promise<void> {
    this.sql.run(
      `UPDATE messages SET message = json_set(json_remove(message, '$.verified'), '$.preview', 'as before')`,
    );
    this.sql.run(`UPDATE conversations SET summary = json_remove(summary, '$.avatar')`);
    return Promise.resolve();
  }

  /** Reads every folder again, as the version that asks for it does, from a cold start. */
  async rereadAsUpgraded(): Promise<void> {
    this.sql.run(REREAD);
    await this.ctx.storage.sync();
    await this.restart();
  }

  private restartOnAcceptance = false;

  /**
   * Ends this instance the next time a host accepts a message, before the Outbox can record it:
   * the one instant a restart leaves a send's fate unknown.
   */
  restartWhenAccepted(): Promise<void> {
    this.restartOnAcceptance = true;
    return Promise.resolve();
  }

  protected override accepted(): void {
    if (this.restartOnAcceptance) this.ctx.abort('A test restarted the Mailroom mid-send.');
  }

  /**
   * Has an account's provider leave Sent to the host, as Zoho's and Outlook's presets do, and
   * restarts so the provider is made again. Setup can't say so for a host it names itself.
   */
  async hostFilesSent(account: string): Promise<void> {
    this.sql.run(
      `UPDATE accounts SET connection = json_set(connection, '$.filesSent', json('true')) WHERE id = ?`,
      account,
    );
    // A restart drops writes not yet on disk.
    await this.ctx.storage.sync();
    await this.restart();
  }

  /**
   * Has every send that waits for its host's copy in Sent wait no longer, as two minutes passing
   * would, and wakes the Mailroom to file it.
   */
  async hostFilingOverdue(): Promise<void> {
    const now = Date.now();
    this.sql.run(
      `UPDATE outbox SET outgoing = json_set(outgoing, '$.acceptedAt', ?, '$.sendAt', ?)
        WHERE json_extract(outgoing, '$.state') = 'accepted'`,
      new Date(now - HOST_FILING_SECONDS * 1000).toISOString(),
      new Date(now).toISOString(),
    );
    await this.ctx.storage.setAlarm(now);
  }

  private imapLoads = 0;

  protected override imapCode() {
    this.imapLoads++;
    return super.imapCode();
  }

  /** How many times this instance has asked for the IMAP provider's code. */
  imapLoadCount(): Promise<number> {
    return Promise.resolve(this.imapLoads);
  }

  private readonly synced: Synced[] = [];

  /** Records what each folder's sync downloads: the messages it reports, by path. */
  protected override reached(provider: MailProvider): MailProvider {
    return {
      ...provider,
      sync: async (path, cursor, window) => {
        const batch = await provider.sync(path, cursor, window);
        const messages = batch.events.filter(({ type }) => type === 'message').length;
        this.synced.push({ path, messages });
        return batch;
      },
    };
  }

  /** Each folder sync since the Mailroom started, with how many messages it downloaded. */
  syncLog(): Promise<Synced[]> {
    return Promise.resolve(this.synced);
  }

  private bucketDelay = 0;

  /** Has the bucket wait this long before deleting, so a test can look in while it does. */
  slowBucket(ms: number): Promise<void> {
    this.bucketDelay = ms;
    return Promise.resolve();
  }

  protected override async forgetBodies(prefix: string): Promise<void> {
    if (this.bucketDelay) await new Promise((resolve) => setTimeout(resolve, this.bucketDelay));
    await super.forgetBodies(prefix);
  }

  private isHoldingBodies = false;

  /**
   * Has every wake keep the bodies it owes a delete, as if each ended before letting them go, until
   * a test lets them go again or the instance restarts.
   */
  holdBodies(isHeld: boolean): Promise<void> {
    this.isHoldingBodies = isHeld;
    return Promise.resolve();
  }

  protected override letBodiesGo(): Promise<boolean> {
    return this.isHoldingBodies ? Promise.resolve(false) : super.letBodiesGo();
  }

  /** Where a folder's sync stands, as its provider left the cursor. */
  cursorOf(account: string, path: string): Promise<string | null> {
    return Promise.resolve(this.store.cursor(account, path));
  }

  /** Sets a folder's sync back to a cursor it left, so its next sync reports again what followed. */
  rewind(account: string, path: string, cursor: string): Promise<void> {
    this.store.saveCursor(account, path, cursor);
    return Promise.resolve();
  }

  private readonly pushed: Pushed[] = [];
  private pushAnswer = 201;

  /** Keeps each push as it would have gone, for a test's stand-in push service to open. */
  protected override async postPush(request: Request): Promise<Response> {
    const body = new Uint8Array(await request.arrayBuffer());
    this.pushed.push({
      url: request.url,
      headers: [...request.headers],
      body: btoa(String.fromCharCode(...body)),
    });
    return new Response(null, { status: this.pushAnswer });
  }

  /** Every push since the Mailroom started, its body base64. */
  pushes(): Promise<Pushed[]> {
    return Promise.resolve(this.pushed);
  }

  /** Notifies a device unchecked, as no browser could have it, such as one whose keys can't seal. */
  notifyUnchecked(subscription: unknown): Promise<void> {
    this.sql.run(
      `INSERT INTO devices (endpoint, subscription, added) VALUES (?, ?, 0)`,
      (subscription as { endpoint: string }).endpoint,
      JSON.stringify(subscription),
    );
    return Promise.resolve();
  }

  /** Has every push service answer each push from now on with this status. */
  answerPushesWith(status: number): Promise<void> {
    this.pushAnswer = status;
    return Promise.resolve();
  }

  /** Erases the envelope index and the body cache, which sync rebuilds from the servers. */
  async eraseIndex(): Promise<void> {
    for (const { id } of await this.accounts()) this.store.forget(id);
    await this.forgetBodies(`${this.member}/`);
  }

  /** A preset as this Mailroom reaches it, from its settings, with any stand-ins it honors. */
  presetFrom(name: PresetName): Promise<Preset> {
    return Promise.resolve(this.preset(name));
  }

  /** Every row Trail Mix stored for this member, blobs as Latin-1 text, and every cached body. */
  async stored(): Promise<{ tables: Record<string, unknown[]>; bodies: string[] }> {
    const tables: Record<string, unknown[]> = {};
    const names = this.sql.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_\\_miniflare%' ESCAPE '\\'`,
    );
    for (const { name } of names) {
      tables[name] = this.sql
        .all<Record<string, unknown>>(`SELECT * FROM "${name}"`)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              value instanceof ArrayBuffer ? new TextDecoder('latin1').decode(value) : value,
            ]),
          ),
        );
    }
    const listed = await this.env.BODIES.list({ prefix: `${this.member}/` });
    return { tables, bodies: listed.objects.map((object) => object.key) };
  }
}

export type Synced = { path: string; messages: number };

export type Pushed = { url: string; headers: [string, string][]; body: string };

export type Wake = {
  steps: number;
  accounts: { name: string; status: string; messages: number }[];
};

type Env = MailroomEnv & { MAILROOM: DurableObjectNamespace<TestMailroom> };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, member, action] = url.pathname.split('/');
    if (!member) return new Response('The Mailroom, for tests.');
    const mailroom = env.MAILROOM.get(env.MAILROOM.idFromName(member));
    if (action === 'updates') {
      return mailroom.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }));
    }
    if (action === 'call' && request.method === 'POST') {
      // A call carrying files crosses as it does from a browser, its files read into bytes.
      const { name, args } = request.headers.get('Content-Type')?.startsWith('multipart/form-data')
        ? await receivedCall(COMMANDS, await request.formData())
        : await request.json<{ name: string; args: unknown[] }>();
      const methods = mailroom as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      // A query or command reaches the Mailroom as the Worker sends it. The rest are a test's own.
      const isAsked =
        (QUERIES as readonly string[]).includes(name) ||
        (COMMANDS as readonly string[]).includes(name);
      try {
        const value = isAsked
          ? ((await methods.answer!({ name, args }, Date.now())) as { value: unknown }).value
          : await methods[name]!(...args);
        return Response.json({ value: value ?? null });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    return new Response('Not found', { status: 404 });
  },
};
