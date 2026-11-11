import { DurableObject } from 'cloudflare:workers';
import { networkOf, type VisitorGate as Gate } from './access.ts';

/**
 * The public demo's limits on its visitors, which bound what it can cost. Its visitor gate is the
 * one Durable Object that isn't a Mailroom. Each new visitor asks it once, before their first
 * request makes them a Mailroom, and it lets in at most so many a day in all, and so many a minute
 * from one network, both set in the Wrangler configuration. It holds only today's visitors, by the
 * random ids their cookies carry, and nothing of what they do. Once in, a network's visitors make
 * only so many changes a minute.
 */

/** A Cloudflare Rate Limiting binding, which counts each key's calls in its period. */
export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type VisitorGateEnv = {
  /** How many new visitors the demo lets in a day, in all. */
  NEW_VISITORS_A_DAY?: string;
  /** How many new visitors one network may become a minute, as Cloudflare counts it. */
  NEW_VISITORS?: RateLimit;
};

/** Today's visitors: the UTC day, and the ids let in during it. */
type Today = { day: string; visitors: string[] };

const TODAY = 'today';

export class VisitorGate extends DurableObject<VisitorGateEnv> {
  /**
   * Whether a visitor may come in. One already in today stays in, as their first requests ask
   * at once. A new one comes in while today has room and their network hasn't had its share this
   * minute. The gate decides one visitor at a time, so two can't both take the last place.
   */
  admit(visitor: string, network: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const day = new Date().toISOString().slice(0, 10);
      const held = await this.ctx.storage.get<Today>(TODAY);
      const today = held?.day === day ? held : { day, visitors: [] };
      if (today.visitors.includes(visitor)) return true;
      if (today.visitors.length >= ceilingOf(this.env.NEW_VISITORS_A_DAY)) return false;
      const limit = this.env.NEW_VISITORS;
      if (limit && !(await limit.limit({ key: network })).success) return false;
      await this.ctx.storage.put(TODAY, { day, visitors: [...today.visitors, visitor] });
      return true;
    });
  }
}

/** The demo's one gate, as the Worker asks it. */
export function gateOf(namespace: {
  idFromName(name: string): unknown;
  get(id: unknown): { admit(visitor: string, network: string): Promise<boolean> };
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
