import {
  domainOf,
  type ConversationSummary,
  type Message,
  type SyncEvent,
} from '../../mail/core/index.ts';

/**
 * The Logo cache's rules: which senders may show a logo, what DNS says about a domain's logo, which
 * logos are safe to keep, and how lists and conversations name them.
 *
 * A message is verified when its own server says DMARC passed for its From domain. That proves who
 * sent it, not that the domain's owner wants a logo shown, so a domain's logo is kept only while
 * its DMARC policy quarantines or rejects mail that fails, in full, and its BIMI record names an
 * SVG over HTTPS. A logo is a picture of a brand and nothing more: one that could run or fetch
 * anything is refused.
 */

/** How long a domain's lookup stands before a logo it found is looked up again. */
export const RECHECK_MS = 7 * 24 * 60 * 60_000;

/** The most a logo may weigh, in bytes. */
export const LOGO_BYTES = 32 * 1024;

/** The most domains a lookup asks DNS about for one sender's domain: it, and those above it. */
const WALK = 5;

// Who may show a logo

/** The domains of the verified senders among the messages a batch of sync events brings. */
export function verifiedDomains(events: readonly SyncEvent[]): string[] {
  const domains = new Set<string>();
  for (const event of events) {
    if (event.type !== 'message' || !event.envelope.verified) continue;
    const domain = domainOf(event.envelope.from.email);
    if (domain) domains.add(domain);
  }
  return [...domains];
}

/** Each row with its logo named only while the cache holds it. */
export function namedRows(
  rows: readonly ConversationSummary[],
  held: ReadonlySet<string>,
): ConversationSummary[] {
  return rows.map(({ logo, ...row }) => (logo && held.has(logo) ? { ...row, logo } : row));
}

/** Each message with its From domain named as its logo, when it's verified and the cache holds it. */
export function namedMessages(messages: readonly Message[], held: ReadonlySet<string>): Message[] {
  return messages.map(({ logo: _, ...message }) => {
    const domain = message.verified ? domainOf(message.from.email) : '';
    return held.has(domain) ? { ...message, logo: domain } : message;
  });
}

/** The domains whose logos a set of rows and messages would name, if the cache holds them. */
export function logoCandidates(
  rows: readonly ConversationSummary[],
  messages: readonly Message[] = [],
): string[] {
  const domains = new Set<string>();
  for (const { logo } of rows) if (logo) domains.add(logo);
  for (const message of messages) {
    if (message.verified) domains.add(domainOf(message.from.email));
  }
  domains.delete('');
  return [...domains];
}

// What DNS says

export type Policy = 'none' | 'quarantine' | 'reject';

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
export type Bimi = { logo?: string };

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
