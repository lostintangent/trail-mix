import { domainOf } from '../../mail/core/index.ts';
import { DEMO_PICTURES } from '../../providers/index.ts';
import {
  avatarOf,
  bimiOf,
  dmarcOf,
  enforces,
  hostsPublicMailboxes,
  iconLocations,
  organizationalOf,
  PICTURE_BYTES,
  pictureOf,
  RECHECK_MS,
  txtOf,
  walkOf,
  type Dmarc,
  type IconLink,
  type Picture,
  type Pictures,
} from '../core/avatars.ts';
import { isPublicHost } from '../../../shared/public-host.ts';
import type { Sql } from './schema.ts';

/**
 * The Avatar cache: the pictures of the senders of verified mail, in the Mailroom's storage. Per
 * domain, its BIMI logo and its site's icon, and per sender, their Gravatar photo, each a key into
 * the pictures, whose bytes are kept once under their SHA-256 however many senders show them.
 *
 * A sender and their domain are owed a lookup when verified mail from them arrives, at most once a
 * week, and a picture held is looked up again each week, so one that goes from its source goes
 * from the cache. Like the index, it is disposable: erased, it fills again as mail arrives.
 */
export type AvatarCache = ReturnType<typeof avatarCache>;

/** A picture with the key it is kept and served under. */
export type KeyedPicture = Picture & { key: string };

/**
 * What a lookup of a domain found: its logo, and its site's icon when the logo doesn't make one
 * moot. A site that turned the Mailroom away keeps whatever icon it had.
 */
export type DomainFound<P = KeyedPicture> = { logo?: P; icon?: P | 'none' | 'turned away' };

/** How long a lookup that couldn't reach DNS or Gravatar waits before it tries again. */
const RETRY_MS = 60 * 60_000;

export function avatarCache(sql: Sql) {
  /** Owes a lookup for each name, unless one is owed already or its last was within the week. */
  const owe = (
    table: 'avatar_domains' | 'avatar_senders',
    names: Iterable<string>,
    now: number,
  ) => {
    const column = table === 'avatar_domains' ? 'domain' : 'sender';
    for (const name of names) {
      sql.run(
        `INSERT INTO ${table} (${column}, due_at) VALUES (?, ?)
         ON CONFLICT (${column}) DO UPDATE SET due_at = COALESCE(due_at, MAX(?, checked_at + ?))`,
        name,
        now,
        now,
        RECHECK_MS,
      );
    }
  };

  const hold = (picture: KeyedPicture | undefined) => {
    if (picture === undefined) return;
    sql.run(
      `INSERT INTO avatar_pictures (key, type, bytes) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING`,
      picture.key,
      picture.type,
      picture.bytes,
    );
  };

  /** Lets go of every picture no domain or sender shows. */
  const prune = () =>
    sql.run(
      `DELETE FROM avatar_pictures WHERE key NOT IN (
         SELECT logo FROM avatar_domains WHERE logo IS NOT NULL
         UNION SELECT icon FROM avatar_domains WHERE icon IS NOT NULL
         UNION SELECT photo FROM avatar_senders WHERE photo IS NOT NULL
       )`,
    );

  return {
    /** Owes a lookup for each of these verified senders, and for their domains. */
    note(senders: readonly string[], now: number) {
      owe('avatar_senders', senders, now);
      owe('avatar_domains', new Set(senders.map(domainOf)), now);
    },

    /** The domains and senders owed a lookup by `now`, longest owed first, at most so many of each. */
    owed(now: number, most: { domains: number; senders: number }) {
      const due = (table: string, column: string, limit: number) =>
        sql
          .all<{ name: string }>(
            `SELECT ${column} AS name FROM ${table} WHERE due_at <= ? ORDER BY due_at, ${column} LIMIT ?`,
            now,
            limit,
          )
          .map((row) => row.name);
      return {
        domains: due('avatar_domains', 'domain', most.domains),
        senders: due('avatar_senders', 'sender', most.senders),
      };
    },

    /**
     * Records what a lookup of a domain found. A domain with a picture is looked up again in a week,
     * and one without when verified mail next comes. Returns whether a picture came, went or changed.
     */
    foundDomain(domain: string, found: DomainFound, now: number): boolean {
      return sql.transaction(() => {
        const [held] = sql.all<{ logo: string | null; icon: string | null }>(
          `SELECT logo, icon FROM avatar_domains WHERE domain = ?`,
          domain,
        );
        // A lookup that ends after its domain went keeps nothing.
        if (!held) return false;
        const { logo, icon } = found;
        const kept = {
          logo: logo?.key ?? null,
          icon: icon === 'turned away' ? held.icon : typeof icon === 'object' ? icon.key : null,
        };
        hold(logo);
        if (typeof icon === 'object') hold(icon);
        sql.run(
          `UPDATE avatar_domains SET logo = ?, icon = ?, checked_at = ?, due_at = ? WHERE domain = ?`,
          kept.logo,
          kept.icon,
          now,
          (kept.logo ?? kept.icon) ? now + RECHECK_MS : null,
          domain,
        );
        prune();
        return held.logo !== kept.logo || held.icon !== kept.icon;
      });
    },

    /** Records what Gravatar keeps for a sender, as `foundDomain` does for a domain. */
    foundSender(sender: string, photo: KeyedPicture | undefined, now: number): boolean {
      return sql.transaction(() => {
        const [held] = sql.all<{ photo: string | null }>(
          `SELECT photo FROM avatar_senders WHERE sender = ?`,
          sender,
        );
        if (!held) return false;
        hold(photo);
        sql.run(
          `UPDATE avatar_senders SET photo = ?, checked_at = ?, due_at = ? WHERE sender = ?`,
          photo?.key ?? null,
          now,
          photo ? now + RECHECK_MS : null,
          sender,
        );
        prune();
        return held.photo !== (photo?.key ?? null);
      });
    },

    /** Has a lookup that couldn't finish try again later, keeping whatever pictures it had. */
    failed(which: { domain: string } | { sender: string }, now: number) {
      if ('domain' in which) {
        sql.run(
          `UPDATE avatar_domains SET due_at = ? WHERE domain = ?`,
          now + RETRY_MS,
          which.domain,
        );
      } else {
        sql.run(
          `UPDATE avatar_senders SET due_at = ? WHERE sender = ?`,
          now + RETRY_MS,
          which.sender,
        );
      }
    },

    /** The key of the picture each of these senders shows, for those the cache holds one for. */
    pictures(senders: readonly string[]): Map<string, string> {
      if (senders.length === 0) return new Map();
      const rows = sql.all<Pictures & { sender: string }>(
        `SELECT json_extract(asked.value, '$[0]') AS sender, d.logo, s.photo, d.icon
         FROM json_each(?) AS asked
         LEFT JOIN avatar_senders AS s ON s.sender = json_extract(asked.value, '$[0]')
         LEFT JOIN avatar_domains AS d ON d.domain = json_extract(asked.value, '$[1]')`,
        // One parameter however many senders, since a Durable Object binds at most 100.
        JSON.stringify(senders.map((sender) => [sender, domainOf(sender)])),
      );
      return new Map(
        rows.flatMap((row) => {
          const key = avatarOf(row);
          return key ? [[row.sender, key] as const] : [];
        }),
      );
    },

    /** The picture kept under a key. */
    picture(key: string): Picture | undefined {
      const [row] = sql.all<{ type: string; bytes: ArrayBuffer | Uint8Array }>(
        `SELECT type, bytes FROM avatar_pictures WHERE key = ?`,
        key,
      );
      return row && { type: row.type, bytes: new Uint8Array(row.bytes) };
    },

    /** Forgets every sender but these, and every domain but theirs, as an account's removal does. */
    keep(senders: ReadonlySet<string>) {
      sql.run(
        `DELETE FROM avatar_senders WHERE sender NOT IN (SELECT value FROM json_each(?))`,
        JSON.stringify([...senders]),
      );
      sql.run(
        `DELETE FROM avatar_domains WHERE domain NOT IN (SELECT value FROM json_each(?))`,
        JSON.stringify([...new Set([...senders].map(domainOf))]),
      );
      prune();
    },
  };
}

// Looking pictures up

/** Where the Mailroom finds pictures: a domain's logo and icon, and a sender's photo. */
export type AvatarSources = {
  domain: (domain: string) => Promise<DomainFound<Picture>>;
  sender: (sender: string) => Promise<Picture | undefined>;
};

/** The pictures the internet has, as DNS, Gravatar and senders' sites give them now. */
export function internetSources(network: AvatarNetwork): AvatarSources {
  return {
    domain: (domain) => lookUpDomain(domain, network),
    sender: async (sender) => network.gravatar(await sha256Of(sender)),
  };
}

/** The pictures the demo mailbox brings with it, so nothing is looked up. */
export const demoSources: AvatarSources = {
  domain: (domain) => {
    const logo = DEMO_PICTURES.logos[domain];
    const icon = DEMO_PICTURES.icons[domain];
    return Promise.resolve(
      logo ? { logo: svgPicture(logo) } : { icon: icon ? svgPicture(icon) : 'none' },
    );
  },
  sender: (sender) => {
    const photo = DEMO_PICTURES.photos[sender];
    return Promise.resolve(photo ? svgPicture(photo) : undefined);
  },
};

const svgPicture = (svg: string): Picture => ({
  type: 'image/svg+xml',
  bytes: new Uint8Array(new TextEncoder().encode(svg)),
});

/** A picture with its key: the SHA-256 of its bytes, in hex. */
export async function keyed(picture: Picture): Promise<KeyedPicture> {
  return { ...picture, key: hexOf(await crypto.subtle.digest('SHA-256', picture.bytes)) };
}

const sha256Of = async (text: string) =>
  hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

const hexOf = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** How many of the places a site may keep its icon a lookup tries. */
const ICON_TRIES = 4;

/**
 * A domain's pictures as DNS and its site give them now. Its logo is the SVG its BIMI record names,
 * or else its organizational domain's, kept only while DMARC holds the domain's mail to a policy
 * that quarantines or rejects. Without a logo, its icon is the first picture its organizational
 * domain's home page names, or keeps where sites do, unless that domain hosts public mailboxes.
 */
export async function lookUpDomain(
  domain: string,
  network: AvatarNetwork,
): Promise<DomainFound<Picture>> {
  const walk = walkOf(domain);
  const answers = await Promise.all(walk.map((name) => network.txt(`_dmarc.${name}`)));
  const records = new Map<string, Dmarc>();
  walk.forEach((name, i) => {
    const record = dmarcOf(answers[i]!);
    if (record) records.set(name, record);
  });
  const organizational = organizationalOf(walk, records);
  if (enforces(records.get(domain), records.get(organizational))) {
    const bimi =
      bimiOf(await network.txt(`default._bimi.${domain}`)) ??
      (organizational === domain
        ? undefined
        : bimiOf(await network.txt(`default._bimi.${organizational}`)));
    const logo = bimi?.logo ? await network.picture(bimi.logo) : undefined;
    if (logo?.type === 'image/svg+xml') return { logo };
  }
  if (hostsPublicMailboxes(organizational)) return {};
  return { icon: await lookUpIcon(organizational, network) };
}

async function lookUpIcon(
  domain: string,
  network: AvatarNetwork,
): Promise<Picture | 'none' | 'turned away'> {
  const home = await network.home(domain);
  for (const location of iconLocations(home.links, home.page, home.site).slice(0, ICON_TRIES)) {
    const icon = await network.picture(location).catch(() => undefined);
    if (icon) return icon;
  }
  return home.isTurnedAway ? 'turned away' : 'none';
}

// The internet

/** Where the Mailroom asks: DNS over HTTPS, Gravatar's pictures, and each domain's site. */
export type Internet = { dns: string; gravatar: string; site: (domain: string) => string };

export const INTERNET: Internet = {
  // Cloudflare's DNS over HTTPS, which answers in JSON.
  dns: 'https://cloudflare-dns.com/dns-query',
  gravatar: 'https://gravatar.com/avatar/',
  site: (domain) => `https://${domain}/`,
};

/** The internet as a test's stand-in on this machine serves it, all from one origin. */
export const standInInternet = (origin: string): Internet => ({
  dns: `${origin}/dns-query`,
  gravatar: `${origin}/gravatar/`,
  site: (domain) => `${origin}/sites/${domain}/`,
});

/** A domain's home page as far as its icon goes: where it was asked, where it ended, its icons. */
export type Home = { site: string; page: string; links: IconLink[]; isTurnedAway: boolean };

/** How the Mailroom asks the internet about pictures. */
export type AvatarNetwork = {
  /** The texts of the TXT records at a name, and none when it has none. Throws when DNS can't say. */
  txt: (name: string) => Promise<string[]>;
  /** The picture at an HTTPS location, or none when there is none. Throws when its host can't be reached. */
  picture: (location: string) => Promise<Picture | undefined>;
  /** The photo Gravatar keeps for an address's SHA-256, or none. Throws when Gravatar can't say. */
  gravatar: (hash: string) => Promise<Picture | undefined>;
  /** A domain's home page, or that it turned the Mailroom away. */
  home: (domain: string) => Promise<Home>;
};

/** How long DNS or a host has to answer one request. */
const LOOKUP_MS = 5_000;

/** How many redirects a location may take. */
const MAX_REDIRECTS = 3;

/** How much of a home page is read for its icons, which it names in its head. */
const PAGE_BYTES = 256 * 1024;

/** Who the Mailroom says it is, so a site can tell why it asks. */
const USER_AGENT = 'TrailMix (sender avatars; +https://github.com/lostintangent/trail-mix)';

/**
 * The internet as a Mailroom on Cloudflare reaches it: DNS over HTTPS, and pictures and pages over
 * HTTPS from public hosts, each redirect checked as the first location is. A test's stand-in on
 * this machine serves everything from this machine.
 */
export function avatarNetwork(internet: Internet, isStandIn = false): AvatarNetwork {
  const reachable = (location: string) => {
    const url = URL.parse(location);
    return (
      url?.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (isStandIn || isPublicHost(url.hostname))
    );
  };

  /** The answer at a location, following redirects that stay reachable, or none if one doesn't. */
  async function reach(location: string, accept: string) {
    let at = location;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!reachable(at)) return undefined;
      const response = await fetch(at, {
        redirect: 'manual',
        headers: { accept, 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(LOOKUP_MS),
      });
      const next = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && next) {
        await response.body?.cancel();
        at = new URL(next, at).href;
        continue;
      }
      return { response, url: at };
    }
    return undefined;
  }

  /** A response's picture, read no further than a picture may weigh. */
  async function pictureFrom(response: Response): Promise<Picture | undefined> {
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > PICTURE_BYTES) {
      await response.body?.cancel();
      return undefined;
    }
    const bytes = await bytesWithin(response.body, PICTURE_BYTES);
    return bytes && pictureOf(bytes);
  }

  return {
    async txt(name) {
      const response = await fetch(
        `${internet.dns}?${new URLSearchParams({ name, type: 'TXT' })}`,
        {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(LOOKUP_MS),
        },
      );
      if (!response.ok) throw new Error(`DNS answered ${response.status} for ${name}.`);
      const answer = await response.json<{ Status?: number; Answer?: DnsAnswer[] }>();
      // A name that doesn't exist has no records. Any other failure can't say either way.
      if (answer.Status === 3) return [];
      if (answer.Status !== 0) throw new Error(`DNS couldn’t answer for ${name}.`);
      return (answer.Answer ?? []).flatMap(({ type, data }) =>
        type === TXT && typeof data === 'string' ? [txtOf(data)] : [],
      );
    },

    async picture(location) {
      const reached = await reach(location, 'image/*');
      return reached && pictureFrom(reached.response);
    },

    async gravatar(hash) {
      const reached = await reach(`${internet.gravatar}${hash}?s=96&d=404`, 'image/*');
      if (!reached) throw new Error('Gravatar can’t be reached.');
      const { response } = reached;
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Gravatar answered ${response.status}.`);
      }
      return pictureFrom(response);
    },

    async home(domain) {
      const site = internet.site(domain);
      const reached = await reach(site, 'text/html').catch(() => 'turned away' as const);
      if (reached === 'turned away') return { site, page: site, links: [], isTurnedAway: true };
      if (!reached) return { site, page: site, links: [], isTurnedAway: false };
      const { response, url } = reached;
      const isTurnedAway =
        [401, 403, 429].includes(response.status) ||
        response.status >= 500 ||
        response.headers.get('cf-mitigated') === 'challenge';
      const isPage =
        !isTurnedAway &&
        response.ok &&
        (response.headers.get('content-type') ?? 'text/html').includes('html');
      if (!isPage) {
        await response.body?.cancel();
        return { site, page: url, links: [], isTurnedAway };
      }
      const { links, base } = await iconLinksOf(response, url);
      return { site, page: base ?? url, links, isTurnedAway: false };
    },
  };
}

type DnsAnswer = { type?: number; data?: unknown };

/** The TXT record type's number. */
const TXT = 16;

/** The icons a page names in its first `PAGE_BYTES`, and the base its links resolve against. */
async function iconLinksOf(
  response: Response,
  page: string,
): Promise<{ links: IconLink[]; base?: string }> {
  const links: IconLink[] = [];
  let base: string | undefined;
  const attribute = (element: Element, name: string) => element.getAttribute(name) ?? undefined;
  await new HTMLRewriter()
    .on('base[href]', {
      element(element) {
        base ??= URL.parse(element.getAttribute('href') ?? '', page)?.href;
      },
    })
    .on('link[rel][href]', {
      element(element) {
        links.push({
          rel: element.getAttribute('rel')!,
          href: element.getAttribute('href')!,
          sizes: attribute(element, 'sizes'),
          type: attribute(element, 'type'),
        });
      },
    })
    .transform(new Response(within(response.body, PAGE_BYTES)))
    .arrayBuffer();
  return { links, ...(base ? { base } : {}) };
}

/** A body cut off after `limit` bytes. */
function within(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): ReadableStream<Uint8Array> {
  const reader = body?.getReader();
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
      if (done || size >= limit) {
        if (!done) await reader?.cancel();
        controller.close();
        return;
      }
      const chunk = value.subarray(0, limit - size);
      size += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel: (reason) => reader?.cancel(reason),
  });
}

/** A body's bytes, or none once it passes `limit` bytes, read no further than that. */
async function bytesWithin(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
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
  return bytes;
}
