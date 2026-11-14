import { domainOf, type Message, type SyncEvent } from '../../mail/core/index.ts';

/**
 * The Avatar cache's rules: which senders may show a picture, where each picture comes from and in
 * what order, which pictures are safe to keep, and how lists and conversations name them.
 *
 * A message is verified when its own server says DMARC passed for its From domain. Only a verified
 * sender shows a picture, and anyone else shows their initials. A sender's picture is the first of
 * three that exists. Their brand's BIMI logo proves more than who sent the mail, that the domain's
 * owner wants that logo shown, so it is kept only while the domain's DMARC policy quarantines or
 * rejects mail that fails, in full, and its BIMI record names an SVG over HTTPS. Then the photo
 * the sender keeps at Gravatar, asked for by their address's SHA-256. Then the icon their
 * organizational domain's home page names, unless that domain hosts mailboxes for the public, where
 * an icon would say nothing about the person. A picture is a picture and nothing more: an SVG that
 * could run or fetch anything is refused, and any other picture must be one by its first bytes.
 */
/** How long a lookup stands before what it found is looked up again. */
export const RECHECK_MS = 7 * 24 * 60 * 60_000;

/** The most a logo, or any SVG, may weigh, in bytes. */
export const LOGO_BYTES = 32 * 1024;

/** The most any other picture may weigh, in bytes. */
export const PICTURE_BYTES = 64 * 1024;

/** The most domains a lookup asks DNS about for one sender's domain: it, and those above it. */
const WALK = 5;

// Who may show a picture

/** A picture the Avatar cache holds: its type, as its first bytes showed, and its bytes. */
export type Picture = { type: string; bytes: Uint8Array<ArrayBuffer> };

/** What the Avatar cache knows of one sender: their domain's logo and icon, and their photo. */
export type Pictures = { logo?: string | null; photo?: string | null; icon?: string | null };

/** The picture a sender shows, of those the cache holds: their logo, else photo, else icon. */
export const avatarOf = ({ logo, photo, icon }: Pictures): string | undefined =>
  logo ?? photo ?? icon ?? undefined;

/** A sender's address as the Avatar cache keys it. */
export const senderOf = (address: string) => address.trim().toLowerCase();

/** The verified senders among the messages a batch of sync events brings, once each. */
export function verifiedSenders(events: readonly SyncEvent[]): string[] {
  const senders = new Set<string>();
  for (const event of events) {
    if (event.type !== 'message' || !event.envelope.verified) continue;
    const sender = senderOf(event.envelope.from.email);
    if (domainOf(sender)) senders.add(sender);
  }
  return [...senders];
}

/**
 * Each row with its avatar named by the key its picture is served under, while the cache holds
 * one. The index keeps a row's avatar as the address of its newest verified sender other than the
 * member, and a read names it here.
 */
export function namedRows<Row extends { avatar?: string }>(
  rows: readonly Row[],
  pictures: ReadonlyMap<string, string>,
): Row[] {
  return rows.map((row) => {
    const key = row.avatar === undefined ? undefined : pictures.get(row.avatar);
    if (key) return { ...row, avatar: key };
    const { avatar: _, ...unnamed } = row;
    return unnamed as Row;
  });
}

/** Each message with its sender's picture named, when it's verified and the cache holds one. */
export function namedMessages(
  messages: readonly Message[],
  pictures: ReadonlyMap<string, string>,
): Message[] {
  return messages.map(({ avatar: _, ...message }) => {
    const key = message.verified ? pictures.get(senderOf(message.from.email)) : undefined;
    return key ? { ...message, avatar: key } : message;
  });
}

/** The senders whose pictures a set of rows and messages would name, if the cache holds them. */
export function avatarCandidates(
  rows: readonly { avatar?: string }[],
  messages: readonly Message[] = [],
): string[] {
  const senders = new Set<string>();
  for (const { avatar } of rows) if (avatar) senders.add(avatar);
  for (const message of messages) {
    if (message.verified) senders.add(senderOf(message.from.email));
  }
  return [...senders].filter((sender) => domainOf(sender));
}

// Which pictures are kept

/**
 * A picture as its bytes show it: an SVG that is a safe logo, or PNG, JPEG, GIF, WebP or ICO within
 * `PICTURE_BYTES`, whatever its host said it was. Anything else is none.
 */
export function pictureOf(bytes: Uint8Array<ArrayBuffer>): Picture | undefined {
  const type = RASTERS.find(({ signature }) => signature(bytes))?.type;
  if (type) return bytes.byteLength <= PICTURE_BYTES ? { type, bytes } : undefined;
  if (bytes.byteLength > LOGO_BYTES) return undefined;
  const svg = utf8Of(bytes);
  return svg !== undefined && isSafeLogo(svg) ? { type: 'image/svg+xml', bytes } : undefined;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, i) => bytes[at + i] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

const RASTERS: readonly { type: string; signature: (bytes: Uint8Array) => boolean }[] = [
  { type: 'image/png', signature: (b) => startsWith(b, [0x89, ...ascii('PNG\r\n\x1a\n')]) },
  { type: 'image/jpeg', signature: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    type: 'image/gif',
    signature: (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  },
  {
    type: 'image/webp',
    signature: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  },
  // An icon directory with at least one image in it.
  {
    type: 'image/x-icon',
    signature: (b) => startsWith(b, [0, 0, 1, 0]) && (b[4] ?? 0) + (b[5] ?? 0) > 0,
  },
];

function utf8Of(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

// Where a site keeps its icon

/** A `<link>` a home page has, as far as finding its icon needs it. */
export type IconLink = { rel: string; href: string; sizes?: string; type?: string };

/** The most pixels across that an icon needs, to fill a 32-pixel avatar on a dense screen. */
const ICON_PIXELS = 64;

/**
 * Where a site's icon may be, best first: the icons its home page names, as resolved against
 * `page`, the smallest of those at least 64 pixels across first, then any that scale, then the
 * rest, largest first. After them, where sites keep one by convention, at the root of `site`.
 */
export function iconLocations(links: readonly IconLink[], page: string, site: string): string[] {
  const named = links.flatMap((link) => {
    const rels = link.rel.toLowerCase().split(/\s+/);
    const isTouch = rels.some((rel) => rel.startsWith('apple-touch-icon'));
    if (!isTouch && !rels.includes('icon')) return [];
    const location = URL.parse(link.href.trim(), page);
    if (location?.protocol !== 'https:') return [];
    return [{ location: location.href, pixels: pixelsOf(link, isTouch) }];
  });
  const tier = (pixels: number) => (pixels === Infinity ? 1 : pixels >= ICON_PIXELS ? 0 : 2);
  const ranked = named
    .toSorted(
      (a, b) =>
        tier(a.pixels) - tier(b.pixels) ||
        (tier(a.pixels) === 0 ? a.pixels - b.pixels : b.pixels - a.pixels),
    )
    .map(({ location }) => location);
  const conventional = ['apple-touch-icon.png', 'favicon.ico'].map(
    (name) => new URL(name, site).href,
  );
  return [...new Set([...ranked, ...conventional])];
}

/** How many pixels across an icon says it is: its largest size, endless if it scales. */
function pixelsOf({ sizes, type, href }: IconLink, isTouch: boolean): number {
  const declared = (sizes ?? '').toLowerCase().split(/\s+/);
  if (declared.includes('any')) return Infinity;
  const widths = declared.flatMap((size) => /^(\d+)x\d+$/.exec(size)?.[1] ?? []).map(Number);
  if (widths.length > 0) return Math.max(...widths);
  if (type?.toLowerCase() === 'image/svg+xml' || /\.svg(\?|#|$)/i.test(href)) return Infinity;
  // Apple draws a touch icon that says no size at 180 pixels, and a favicon is most often 16 or 32.
  return isTouch ? 180 : 0;
}

/**
 * Whether a domain hosts mailboxes for the public, so its icon says nothing about who wrote. Given
 * the organizational domain, as the DMARC walk finds it.
 */
export function hostsPublicMailboxes(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  return (
    PUBLIC_MAILBOXES.has(domain.toLowerCase()) ||
    // A provider's mailboxes under each of its country domains, such as yahoo.co.jp or gmx.de.
    (labels.length <= 3 &&
      PUBLIC_MAILBOX_BRANDS.has(labels[0]!) &&
      labels.slice(1).every((label) => label.length <= 3))
  );
}

const PUBLIC_MAILBOX_BRANDS = new Set([
  'aol',
  'gmail',
  'gmx',
  'googlemail',
  'hotmail',
  'icloud',
  'live',
  'outlook',
  'protonmail',
  'yahoo',
  'yandex',
  'ymail',
  'zohomail',
]);

const PUBLIC_MAILBOXES = new Set([
  '126.com',
  '163.com',
  'att.net',
  'btinternet.com',
  'comcast.net',
  'duck.com',
  'fastmail.com',
  'fastmail.fm',
  'free.fr',
  'hanmail.net',
  'hey.com',
  'hushmail.com',
  'laposte.net',
  'libero.it',
  'mac.com',
  'mail.com',
  'mail.ru',
  'mailbox.org',
  'me.com',
  'msn.com',
  'naver.com',
  'orange.fr',
  'pm.me',
  'posteo.de',
  'proton.me',
  'qq.com',
  'rediffmail.com',
  'rocketmail.com',
  'seznam.cz',
  'tuta.io',
  'tutanota.com',
  'verizon.net',
  'web.de',
  'wp.pl',
  'zoho.com',
]);

// What DNS says

type Policy = 'none' | 'quarantine' | 'reject';

/** A domain's DMARC record, as far as a logo needs it. */
export type Dmarc = {
  /** The policy for the domain itself. */
  p: Policy;
  /** The policy for the domains under it, when it sets one apart. */
  sp?: Policy;
  /** The share of failing mail the policy applies to, from 0 to 100. */
  pct: number;
  /** Whether the domain says it is a public suffix, under which others register their own. */
  psd: boolean;
};

/** A domain's BIMI record: the SVG it names, or none when it names no logo Trail Mix can fetch. */
type Bimi = { logo?: string };

/**
 * The text of one TXT record as DNS over HTTPS gives it: one or more quoted strings, joined into
 * one as DNS joins them, with their escapes read.
 */
export function txtOf(data: string): string {
  if (!data.trimStart().startsWith('"')) return data;
  let text = '';
  let quoted = false;
  for (let i = 0; i < data.length; i++) {
    const char = data[i]!;
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted) {
      continue;
    } else if (char === '\\') {
      const digits = /^\d{3}/.exec(data.slice(i + 1))?.[0];
      text += digits ? String.fromCharCode(Number(digits)) : (data[i + 1] ?? '');
      i += digits ? 3 : 1;
    } else {
      text += char;
    }
  }
  return text;
}

/** A domain's DMARC record from the TXT records at `_dmarc.<domain>`. More than one counts as none. */
export function dmarcOf(records: readonly string[]): Dmarc | undefined {
  const found = records.map(tagsOf).filter((tags) => tags.get('v') === 'DMARC1');
  const tags = found.length === 1 ? found[0]! : undefined;
  if (!tags) return undefined;
  const sp = policy(tags.get('sp'));
  const pct = tags.get('pct') ?? '100';
  return {
    // A record with no policy it can read, but somewhere to report, monitors and enforces nothing.
    p: policy(tags.get('p')) ?? 'none',
    ...(sp ? { sp } : {}),
    pct: /^\d{1,3}$/.test(pct) ? Math.min(Number(pct), 100) : 100,
    psd: tags.get('psd')?.toLowerCase() === 'y',
  };
}

/** A domain's BIMI record from the TXT records at `default._bimi.<domain>`, if it has exactly one. */
export function bimiOf(records: readonly string[]): Bimi | undefined {
  const found = records.map(tagsOf).filter((tags) => tags.get('v') === 'BIMI1');
  const tags = found.length === 1 ? found[0]! : undefined;
  if (!tags) return undefined;
  // A list of locations is read for its first, as the first drafts of BIMI allowed.
  const location = tags.get('l')?.split(',')[0]?.trim() ?? '';
  return isHttps(location) ? { logo: location } : {};
}

/** The domains a lookup asks about for a sender's domain: it, then those above it, nearest first. */
export function walkOf(domain: string): string[] {
  const labels = domain.split('.');
  const above = labels.slice(1).map((_, i) => labels.slice(i + 1).join('.'));
  // Down to two labels, and only the highest of them when there are many.
  return [domain, ...above.slice(0, -1).slice(-(WALK - 1))];
}

/**
 * The organizational domain a walk finds: the highest domain with a DMARC record, or the one
 * below it when that record says it is a public suffix.
 */
export function organizationalOf(
  walk: readonly string[],
  records: ReadonlyMap<string, Dmarc>,
): string {
  for (let i = walk.length - 1; i >= 0; i--) {
    const record = records.get(walk[i]!);
    if (!record) continue;
    return record.psd && i > 0 ? walk[i - 1]! : walk[i]!;
  }
  return walk[0]!;
}

/**
 * Whether a domain's mail is held to DMARC in full: the policy that applies to it, its own record's
 * or else its organizational domain's for the domains under it, quarantines or rejects all failing
 * mail, and so does the organizational domain's own, as BIMI asks.
 */
export function enforces(own: Dmarc | undefined, organizational: Dmarc | undefined): boolean {
  const applies = own ?? organizational;
  if (!applies) return false;
  const policy = own ? own.p : (applies.sp ?? applies.p);
  const isEnforced = (record: Dmarc, by: Policy) => by !== 'none' && record.pct === 100;
  return (
    isEnforced(applies, policy) && (!organizational || isEnforced(organizational, organizational.p))
  );
}

// Which logos are kept

/**
 * Whether an SVG is a logo Trail Mix keeps: a document of at most `LOGO_BYTES` whose root is an
 * `svg`, with no script, no handler, no embedded document, no entity and no reference outside
 * itself. Browsers draw a logo only as an image, which runs and fetches nothing anyway, so this is
 * the second of two walls.
 */
export function isSafeLogo(svg: string): boolean {
  if (new TextEncoder().encode(svg).byteLength > LOGO_BYTES) return false;
  const prologue =
    /^\uFEFF?\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>[]*>)\s*)*<svg[\s>]/i;
  if (!prologue.test(svg)) return false;
  return !UNSAFE.some((pattern) => pattern.test(svg));
}

const UNSAFE: readonly RegExp[] = [
  /<\s*(script|foreignObject|iframe|embed|object|handler|listener)\b/i,
  /<!ENTITY/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  // Every reference stays inside the logo: `#id`, and nothing else.
  /\b(xlink:)?href\s*=\s*(["'])(?!\s*#)/i,
  /url\(\s*["']?\s*(?!#)/i,
  /@import/i,
];

// Reading records

/** A record's tags, by lowercased name, as DMARC and BIMI write them: `name=value` between `;`. */
function tagsOf(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim().toLowerCase();
    if (!tags.has(name)) tags.set(name, part.slice(at + 1).trim());
  }
  return tags;
}

function policy(value: string | undefined): Policy | undefined {
  const lower = value?.toLowerCase();
  return lower === 'none' || lower === 'quarantine' || lower === 'reject' ? lower : undefined;
}

function isHttps(location: string): boolean {
  try {
    return new URL(location).protocol === 'https:';
  } catch {
    return false;
  }
}
