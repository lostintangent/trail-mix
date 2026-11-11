import {
  bimiOf,
  dmarcOf,
  enforces,
  isSafeLogo,
  LOGO_BYTES,
  organizationalOf,
  RECHECK_MS,
  txtOf,
  walkOf,
  type Dmarc,
} from '../core/logos.ts';
import { isPublicHost } from '../../../shared/public-host.ts';
import type { Sql } from './schema.ts';

/**
 * The Logo cache: the BIMI logos of the domains that send the member verified mail, one row per
 * domain in the Mailroom's storage. A domain is owed a lookup when verified mail from it arrives,
 * at most once a week, and a logo it holds is looked up again each week, so one whose domain stops
 * enforcing DMARC goes. Like the index, it is disposable: erased, it fills again as mail arrives.
 */
export type LogoCache = ReturnType<typeof logoCache>;

/** How long a lookup that couldn't reach DNS or the logo's host waits before it tries again. */
const RETRY_MS = 60 * 60_000;

export function logoCache(sql: Sql) {
  return {
    /** Owes a lookup for each domain, unless one is owed already or its last was within the week. */
    note(domains: readonly string[], now: number) {
      for (const domain of domains) {
        sql.run(
          `INSERT INTO logos (domain, due_at) VALUES (?, ?)
           ON CONFLICT (domain) DO UPDATE SET due_at = COALESCE(due_at, MAX(?, checked_at + ?))`,
          domain,
          now,
          now,
          RECHECK_MS,
        );
      }
    },

    /** The domains owed a lookup by `now`, longest owed first, at most `limit`. */
    owed(now: number, limit: number): string[] {
      return sql
        .all<{ domain: string }>(
          `SELECT domain FROM logos WHERE due_at <= ? ORDER BY due_at, domain LIMIT ?`,
          now,
          limit,
        )
        .map((row) => row.domain);
    },

    /**
     * Records what a lookup found: the domain's logo, or none. A logo is looked up again in a week,
     * and a domain without one when verified mail next comes. Returns whether its logo came, went
     * or changed.
     */
    found(domain: string, svg: string | undefined, now: number): boolean {
      const [held] = sql.all<{ svg: string | null }>(
        `SELECT svg FROM logos WHERE domain = ?`,
        domain,
      );
      sql.run(
        `UPDATE logos SET svg = ?, checked_at = ?, due_at = ? WHERE domain = ?`,
        svg ?? null,
        now,
        svg === undefined ? null : now + RECHECK_MS,
        domain,
      );
      return held !== undefined && (held.svg ?? undefined) !== svg;
    },

    /** Has a lookup that couldn't finish try again later, keeping whatever logo the domain had. */
    failed(domain: string, now: number) {
      sql.run(`UPDATE logos SET due_at = ? WHERE domain = ?`, now + RETRY_MS, domain);
    },

    /** Which of these domains have a logo. */
    held(domains: readonly string[]): Set<string> {
      if (domains.length === 0) return new Set();
      return new Set(
        sql
          .all<{ domain: string }>(
            `SELECT domain FROM logos WHERE svg IS NOT NULL AND domain IN (SELECT value FROM json_each(?))`,
            // One parameter however many domains, since a Durable Object binds at most 100.
            JSON.stringify(domains),
          )
          .map((row) => row.domain),
      );
    },

    logo(domain: string): string | undefined {
      return (
        sql.all<{ svg: string | null }>(`SELECT svg FROM logos WHERE domain = ?`, domain)[0]?.svg ??
        undefined
      );
    },

    /** Forgets every domain but these, as an account's removal leaves only other accounts' senders. */
    keep(domains: ReadonlySet<string>) {
      sql.run(
        `DELETE FROM logos WHERE domain NOT IN (SELECT value FROM json_each(?))`,
        JSON.stringify([...domains]),
      );
    },
  };
}

// Looking a logo up

/** How the Mailroom asks the internet about a domain's logo. */
export type LogoNetwork = {
  /** The texts of the TXT records at a name, and none when it has none. Throws when DNS can't say. */
  txt: (name: string) => Promise<string[]>;
  /** The SVG at an HTTPS location, or none when it isn't there. Throws when the host can't be reached. */
  svg: (location: string) => Promise<string | undefined>;
};

/** Cloudflare's DNS over HTTPS, which answers in JSON. */
export const DNS_OVER_HTTPS = 'https://cloudflare-dns.com/dns-query';

/** How long DNS or a logo's host has to answer one request. */
const LOOKUP_MS = 5_000;

/**
 * A domain's logo as DNS and the logo's host give it now, or none: the SVG its BIMI record names,
 * or else its organizational domain's, kept only while DMARC holds the domain's mail to a policy
 * that quarantines or rejects, and only when it is a safe logo.
 */
export async function lookUpLogo(
  domain: string,
  network: LogoNetwork,
): Promise<string | undefined> {
  const walk = walkOf(domain);
  const answers = await Promise.all(walk.map((name) => network.txt(`_dmarc.${name}`)));
  const records = new Map<string, Dmarc>();
  walk.forEach((name, i) => {
    const record = dmarcOf(answers[i]!);
    if (record) records.set(name, record);
  });
  const organizational = organizationalOf(walk, records);
  if (!enforces(records.get(domain), records.get(organizational))) return undefined;
  const bimi =
    bimiOf(await network.txt(`default._bimi.${domain}`)) ??
    (organizational === domain
      ? undefined
      : bimiOf(await network.txt(`default._bimi.${organizational}`)));
  if (!bimi?.logo) return undefined;
  const svg = await network.svg(bimi.logo);
  return svg !== undefined && isSafeLogo(svg) ? svg : undefined;
}

/**
 * The internet as a Mailroom on Cloudflare reaches it: DNS through `resolver`, and logos over HTTPS
 * from public hosts, each redirect checked as the first location is. A test's stand-in on this
 * machine serves its logos from this machine too.
 */
export function logoNetwork(resolver: string, isStandIn = false): LogoNetwork {
  const reachable = (location: string) => {
    const url = URL.parse(location);
    return (
      url?.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (isStandIn || isPublicHost(url.hostname))
    );
  };
  return {
    async txt(name) {
      const response = await fetch(`${resolver}?${new URLSearchParams({ name, type: 'TXT' })}`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(LOOKUP_MS),
      });
      if (!response.ok) throw new Error(`DNS answered ${response.status} for ${name}.`);
      const answer = await response.json<{ Status?: number; Answer?: DnsAnswer[] }>();
      // A name that doesn't exist has no records. Any other failure can't say either way.
      if (answer.Status === 3) return [];
      if (answer.Status !== 0) throw new Error(`DNS couldn’t answer for ${name}.`);
      return (answer.Answer ?? []).flatMap(({ type, data }) =>
        type === TXT && typeof data === 'string' ? [txtOf(data)] : [],
      );
    },

    async svg(location) {
      let at = location;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!reachable(at)) return undefined;
        const response = await fetch(at, {
          redirect: 'manual',
          headers: { accept: 'image/svg+xml' },
          signal: AbortSignal.timeout(LOOKUP_MS),
        });
        const next = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && next) {
          await response.body?.cancel();
          at = new URL(next, at).href;
          continue;
        }
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > LOGO_BYTES) {
          await response.body?.cancel();
          return undefined;
        }
        return textWithin(response.body, LOGO_BYTES);
      }
      return undefined;
    },
  };
}

/** How many redirects a logo's location may take. */
const MAX_REDIRECTS = 3;

type DnsAnswer = { type?: number; data?: unknown };

/** The TXT record type's number. */
const TXT = 16;

/** A body as UTF-8 text, or none once it passes `limit` bytes, read no further than that. */
async function textWithin(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | undefined> {
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}
