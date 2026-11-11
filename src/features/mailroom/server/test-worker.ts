import { COMMANDS, QUERIES, receivedCall } from '../client/contract.ts';
import { HOST_FILING_SECONDS } from '../../outbox/core/index.ts';
import type { MailProvider, Preset, PresetName } from '../../providers/index.ts';
import { Mailroom, type MailroomEnv } from './mailroom.ts';

/**
 * The Mailroom on workerd, for tests. A path's first segment names the member, standing in for the
 * Worker's sign-in, which `src/server` proves. `POST /<member>/call` runs a query or command,
 * `/<member>/updates` opens the hint socket, and the subclass adds what a test needs to look inside.
 */
export class TestMailroom extends Mailroom {
  private readonly wakes: Wake[] = [];

  /** Records each wake that landed anything, with each account's status and indexed mail after it. */
  protected override async wake(): Promise<number> {
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
