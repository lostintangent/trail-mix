/**
 * What the service worker does with each request the app makes. It keeps two things: the app's
 * built files, which never change under a name, and the shell of the build it came with. Everything
 * else, every query, command, socket, message part and image, goes to the network as it would
 * without a worker, so Access and the Mailroom see exactly what they see today.
 */

/** The parts of a request the worker decides by. */
type Asked = { method: string; mode: string; url: string };

/**
 * - `shell`: a page load, answered by the network, and by the build's kept shell only when the
 *   network can't be reached. A redirect, such as Access's sign-in, passes through untouched.
 * - `kept`: one of the build's own files, answered from what the worker keeps.
 * - `network`: left alone.
 */
type Answer = 'shell' | 'kept' | 'network';

export function answerFor(
  { method, mode, url }: Asked,
  origin: string,
  kept: ReadonlySet<string>,
): Answer {
  const { origin: asked, pathname } = new URL(url);
  if (method !== 'GET' || asked !== origin) return 'network';
  if (mode === 'navigate') return 'shell';
  return kept.has(pathname) ? 'kept' : 'network';
}

/**
 * Whether a page the network sent is the shell of the build whose files are `kept`: every built
 * file it names is one of them. A shell from a newer deployment names files this worker doesn't
 * keep, and would fail offline, so it waits for the newer worker, which comes with it.
 */
export function isShellOf(html: string, kept: ReadonlySet<string>): boolean {
  const named = html.match(/\/assets\/[\w.-]+/g) ?? [];
  return named.length > 0 && named.every((path) => kept.has(path));
}
