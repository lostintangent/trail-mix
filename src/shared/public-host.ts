/**
 * Whether a host can only be somewhere on the internet. A Worker cannot reach a private network,
 * but the local runtime can, so names and addresses that mean this machine or its network are out.
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return false;
  if (host.startsWith('[')) return false;
  const octets = host.split('.');
  if (octets.length !== 4 || !octets.every((octet) => /^\d+$/.test(octet))) return true;
  const [a = 0, b = 0] = octets.map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168)
  );
}

/** Whether an address is HTTPS with no credentials in it, on a public host unless any will do. */
export const isPublicHttps = (url: URL | null, anyHost = false): boolean =>
  url?.protocol === 'https:' &&
  !url.username &&
  !url.password &&
  (anyHost || isPublicHost(url.hostname));

/** Whether a host names this machine, as a socket writes IPv6 or in a URL's brackets. */
export const isLoopback = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '::1'].includes(hostname.replace(/^\[(.*)\]$/, '$1'));
