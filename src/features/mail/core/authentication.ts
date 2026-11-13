import { addressesIn, domainOf } from './addresses.ts';

/**
 * What a message's own mail server vouches for. A receiving server writes its
 * Authentication-Results (RFC 8601) at the top of the message, naming itself first. A sender can
 * write headers of their own below it, so only the topmost one is read, and only under a name the
 * account's preset gives: a server that writes none, or writes it unnamed, vouches for nothing.
 */

/** Whether the account's own server says DMARC passed for the domain in the message's From. */
export function isVerified(
  headerBlock: string,
  servers: readonly string[],
  fromAddress: string,
): boolean {
  return isVerifiedIn(headerLines(headerBlock), servers, fromAddress);
}

/**
 * The HTTPS address a message offers to unsubscribe at in one click (RFC 8058), when its own
 * server vouches for every part of the offer, or nothing. The message is verified, its one
 * List-Unsubscribe holds exactly one HTTPS address and no plain HTTP one, its one
 * List-Unsubscribe-Post says One-Click, and a DKIM signature its server found passing covers both
 * headers, so no one along the way could have added or changed them.
 */
export function oneClickUnsubscribe(
  headerBlock: string,
  servers: readonly string[],
): string | undefined {
  const lines = headerLines(headerBlock);
  const only = (name: string) => {
    const found = lines.filter((line) => line.name === name);
    return found.length === 1 ? found[0]!.value : undefined;
  };
  const from = addressesIn(only('from') ?? '');
  if (from.length !== 1 || !isVerifiedIn(lines, servers, from[0]!.email)) return undefined;
  if (only('list-unsubscribe-post')?.trim() !== 'List-Unsubscribe=One-Click') return undefined;
  const address = oneHttpsAddress(only('list-unsubscribe') ?? '');
  if (!address) return undefined;
  const results = trustedResults(lines, servers) ?? [];
  const signatures = lines.filter(({ name }) => name === 'dkim-signature').map(signatureOf);
  const covered = results.some(
    (result) => result.method === 'dkim=pass' && coversList(signedBy(result, signatures)),
  );
  return covered ? address : undefined;
}

function isVerifiedIn(lines: HeaderLine[], servers: readonly string[], fromAddress: string) {
  const domain = domainOf(fromAddress);
  if (!domain) return false;
  return (trustedResults(lines, servers) ?? []).some((result) => {
    if (result.method !== 'dmarc=pass') return false;
    const from = result.properties.get('header.from');
    return from !== undefined && domainNamed(from) === domain;
  });
}

/** One result of an Authentication-Results header: `method=result`, and its properties by name. */
type Result = { method: string; properties: Map<string, string> };

/** The results the topmost Authentication-Results gives, when it's in a name the account trusts. */
function trustedResults(lines: HeaderLine[], servers: readonly string[]): Result[] | undefined {
  const topmost = lines.find(({ name }) => name === 'authentication-results');
  if (!topmost || servers.length === 0) return undefined;
  const [authority = '', ...results] = withoutComments(topmost.value).split(';');
  const serverName = authority.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!servers.some((server) => server.toLowerCase() === serverName)) return undefined;
  return results.map((result) => {
    const [method = '', ...properties] = result.trim().split(/\s+/);
    return {
      method: method.toLowerCase(),
      properties: new Map(
        properties.flatMap((property) => {
          const equals = property.indexOf('=');
          return equals > 0
            ? [[property.slice(0, equals).toLowerCase(), property.slice(equals + 1)] as const]
            : [];
        }),
      ),
    };
  });
}

/**
 * The domain a `header.from` or `header.d` names. RFC 8601 writes a domain, perhaps quoted, but
 * some servers write an address, bare or in angle brackets, so it is read as the part after its `@`.
 */
function domainNamed(value: string): string {
  const unwrapped = value.replace(/^["<]+|[">]+$/g, '');
  return unwrapped
    .slice(unwrapped.lastIndexOf('@') + 1)
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * The one HTTPS address among a List-Unsubscribe's (RFC 2369), each in angle brackets, with
 * whitespace inside them ignored and comments between them. A plain HTTP address, or a second
 * HTTPS one, makes the offer unclear, so there is none. Mail addresses may sit beside it.
 */
function oneHttpsAddress(header: string): string | undefined {
  const uris: string[] = [];
  let depth = 0;
  let uri: string | undefined;
  for (const character of header) {
    if (uri !== undefined) {
      if (character === '>') {
        uris.push(uri);
        uri = undefined;
      } else if (!/\s/.test(character)) uri += character;
    } else if (character === '(') depth++;
    else if (character === ')' && depth > 0) depth--;
    else if (character === '<' && depth === 0) uri = '';
  }
  const web = uris.filter((each) => /^https?:/i.test(each));
  if (web.length !== 1 || !/^https:/i.test(web[0]!) || !URL.canParse(web[0]!)) return undefined;
  const url = new URL(web[0]!);
  return url.username || url.password ? undefined : url.href;
}

/** What a DKIM-Signature (RFC 6376) says: its domain, its signature, and the headers it signs. */
type Signature = { domain: string; b: string; signs: Set<string> };

function signatureOf({ value }: HeaderLine): Signature {
  const tags = new Map(
    value.split(';').flatMap((tag) => {
      const equals = tag.indexOf('=');
      return equals > 0
        ? [[tag.slice(0, equals).trim().toLowerCase(), tag.slice(equals + 1)] as const]
        : [];
    }),
  );
  const tag = (name: string) => (tags.get(name) ?? '').replace(/\s+/g, '');
  return {
    domain: tag('d').toLowerCase(),
    b: tag('b'),
    signs: new Set(tag('h').toLowerCase().split(':')),
  };
}

/**
 * The signatures a passing DKIM result may be speaking of: those of the domain it names, and of
 * the signature whose start it gives (RFC 6008). One that names no domain may be any of them.
 */
function signedBy(result: Result, signatures: Signature[]): Signature[] {
  const domain = result.properties.get('header.d');
  const b = result.properties.get('header.b')?.replace(/^"|"$/g, '');
  return signatures.filter(
    (signature) =>
      (domain === undefined || signature.domain === domainNamed(domain)) &&
      (b === undefined || signature.b.startsWith(b)),
  );
}

/** Whether every one of the signatures signs both list headers, and there is at least one. */
function coversList(signatures: Signature[]): boolean {
  return (
    signatures.length > 0 &&
    signatures.every(
      ({ signs }) => signs.has('list-unsubscribe') && signs.has('list-unsubscribe-post'),
    )
  );
}

type HeaderLine = { name: string; value: string };

/**
 * Header lines in order, by lowercase name, with folding undone. A whole message gives the lines
 * of its header, which ends at the first empty line.
 */
function headerLines(block: string): HeaderLine[] {
  return block
    .split(/\r?\n\r?\n/, 1)[0]!
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .flatMap((line) => {
      const colon = line.indexOf(':');
      return colon > 0
        ? [{ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() }]
        : [];
    });
}

/** A header's value with its comments, which may nest, taken out. */
function withoutComments(value: string): string {
  let depth = 0;
  let kept = '';
  for (const character of value) {
    if (character === '(') depth++;
    else if (character === ')' && depth > 0) depth--;
    else if (depth === 0) kept += character;
  }
  return kept;
}
