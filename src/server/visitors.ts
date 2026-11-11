import { DurableObject } from 'cloudflare:workers';
import { networkOf, VISITOR_SECONDS, type VisitorGate as Gate } from './access.ts';

/**
 * The public demo's limits on its visitors, which bound what it can cost. Its visitor gate is the
 * one Durable Object that isn't a Mailroom. A visitor asks it before their first request makes them
 * a Mailroom, and again each `VISITOR_SECONDS` they keep coming back, and it lets visitors in at
 * most so many times a day in all, and so many a minute from one network, both set in the Wrangler
 * configuration. It holds only today's, by the random ids their cookies carry, and nothing of what
 * they do. Once in, a network's visitors make only so many changes a minute.
 */

/** A Cloudflare Rate Limiting binding, which counts each key's calls in its period. */
export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type VisitorGateEnv = {
  /**
   * How many times the demo lets a visitor in a day, in all. The day's admissions are one stored
   * value, which holds about 2,000 at most, so a larger ceiling needs them kept as rows.
   */
  NEW_VISITORS_A_DAY?: string;
  /** How many new visitors one network may become a minute, as Cloudflare counts it. */
  NEW_VISITORS?: RateLimit;
};

/**
 * Today's admissions: the UTC day, how many times the gate has let a visitor in during it, and when
 * it last let in each visitor, in milliseconds since the epoch.
 */
type Today = { day: string; count: number; letIn: Record<string, number> };

const TODAY = 'admissions';

export class VisitorGate extends DurableObject<VisitorGateEnv> {
  /**
   * Whether a visitor may come in, and when they were let in. One let in within `VISITOR_SECONDS`
   * gets the time they were let in, as their first requests ask at once. Anyone else is let in now,
   * taking a place, while today has room and their network hasn't had its share this minute. The
   * gate decides one visitor at a time, so two can't both take the last place.
   */
  admit(visitor: string, network: string): Promise<number | undefined> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const held = await this.ctx.storage.get<Today>(TODAY);
      const today = held?.day === day ? held : { day, count: 0, letIn: {} };
      const letIn = today.letIn[visitor];
      if (letIn !== undefined && now - letIn < VISITOR_SECONDS * 1000) return letIn;
      if (today.count >= ceilingOf(this.env.NEW_VISITORS_A_DAY)) return undefined;
      const limit = this.env.NEW_VISITORS;
      if (limit && !(await limit.limit({ key: network })).success) return undefined;
      await this.ctx.storage.put(TODAY, {
        day,
        count: today.count + 1,
        letIn: { ...today.letIn, [visitor]: now },
      } satisfies Today);
      return now;
    });
  }
}

/** The demo's one gate, as the Worker asks it. */
export function gateOf(namespace: {
  idFromName(name: string): unknown;
  get(id: unknown): Gate;
}): Gate {
  return {
    admit: (visitor, network) =>
      namespace.get(namespace.idFromName('gate')).admit(visitor, network),
  };
}

/** How many new visitors a day the configuration allows. Anything but a whole number lets none in. */
export function ceilingOf(setting: string | undefined): number {
  return setting !== undefined && /^\d{1,7}$/.test(setting) ? Number(setting) : 0;
}

/**
 * Whether the demo takes another change from a request's network this minute. Each change writes to
 * a visitor's Mailroom, so a script holding one visitor's cookie can't write without end. Queries
 * only read, and aren't counted. A deployment without the limit, as every one but the demo is,
 * takes every change.
 */
export async function isChangeAllowed(
  limit: RateLimit | undefined,
  request: Request,
): Promise<boolean> {
  if (!limit || request.method !== 'POST') return true;
  const network = networkOf(request.headers.get('CF-Connecting-IP') ?? '');
  return (await limit.limit({ key: network })).success;
}

/** The demo's answer to a network past its changes for the minute. */
export function tooManyChanges(): Response {
  return new Response(
    'The demo takes only so many changes a minute from one network. Wait a moment and try again.',
    { status: 429, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' } },
  );
}
