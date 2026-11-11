import { domainOf } from '../../../mail/core/index.ts';

/**
 * Whether a message's own mail server vouches for its sender. A receiving server writes its
 * Authentication-Results (RFC 8601) at the top of the message, naming itself first. A sender can
 * write headers of their own below it, so only the topmost one is read, and only under a name the
 * account's preset gives: a server that writes none, or writes it unnamed, vouches for nothing. The
 * message is verified when that header says DMARC passed for the domain in its From.
 */
export function isVerified(
  headerBlock: string,
  servers: readonly string[],
  fromAddress: string,
): boolean {
  if (servers.length === 0) return false;
  const domain = domainOf(fromAddress);
  if (!domain) return false;
  const topmost = headerLines(headerBlock).find(({ name }) => name === 'authentication-results');
  if (!topmost) return false;
  const [authority = '', ...results] = withoutComments(topmost.value).split(';');
  const serverName = authority.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!servers.some((server) => server.toLowerCase() === serverName)) return false;
  return results.some((result) => {
    const [method, ...properties] = result.trim().split(/\s+/);
    if (method?.toLowerCase() !== 'dmarc=pass') return false;
    const from = properties.find((property) => property.toLowerCase().startsWith('header.from='));
    return from !== undefined && domainNamed(from.slice('header.from='.length)) === domain;
  });
}

/**
 * The domain a `header.from` names. RFC 8601 writes a domain, perhaps quoted, but some servers
 * write the From address, bare or in angle brackets, so it is read as the part after its `@`.
 */
function domainNamed(value: string): string {
  const unwrapped = value.replace(/^["<]+|[">]+$/g, '');
  return unwrapped
    .slice(unwrapped.lastIndexOf('@') + 1)
    .replace(/\.$/, '')
    .toLowerCase();
}

/** Header lines in order, by lowercase name, with folding undone. */
function headerLines(block: string): { name: string; value: string }[] {
  return block
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
