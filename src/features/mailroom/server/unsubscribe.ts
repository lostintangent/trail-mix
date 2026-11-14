import { isPublicHost } from '../../../shared/public-host.ts';
import { oneClickUnsubscribe, type AccountId, type MessageRef } from '../../mail/core/index.ts';
import { namesThisMachine, type DemoServer } from '../../providers/index.ts';
import type { Unsubscribed } from '../client/contract.ts';

/** What carries a POST: the internet, or the demo's list servers, which stand in for it. */
type Post = (url: URL, init: RequestInit) => Promise<Response>;

export type OneClick = ReturnType<typeof oneClick>;

/**
 * Leaving the list a message came from, by the one-click offer its body names: checked again from
 * the message itself, then posted as `unsubscribeAt` says. The demo's list servers answer it
 * without the network, since nothing in the demo is real.
 */
export function oneClick(ports: {
  bytes: (ref: MessageRef) => Promise<Uint8Array | null>;
  /** The names whose Authentication-Results an account's mail is verified by. */
  signersOf: (account: AccountId) => readonly string[];
  /** The demo's list servers, for a demo account alone. */
  demoLists: (account: AccountId) => Promise<DemoServer | undefined>;
  /** A test's stand-in for the senders' servers, honored only when it names this machine. */
  standIn: string | undefined;
}) {
  return {
    async unsubscribe(message: MessageRef): Promise<Unsubscribed> {
      const bytes = await ports.bytes(message);
      if (!bytes) throw new Error('That message is no longer in this mailbox.');
      const address = oneClickUnsubscribe(headerOf(bytes), ports.signersOf(message.account));
      if (!address) {
        return { taken: false, reason: 'This message doesn’t offer to unsubscribe in one click.' };
      }
      const lists = await ports.demoLists(message.account);
      if (lists) return unsubscribeAt(address, (url) => lists.unsubscribe(url.href));
      const { standIn } = ports;
      return unsubscribeAt(
        address,
        internet,
        standIn && namesThisMachine(standIn) ? standIn : undefined,
      );
    },
  };
}

/**
 * One-click unsubscribe (RFC 8058) as the Mailroom carries it out: one POST of
 * `List-Unsubscribe=One-Click`, as a form, to the HTTPS address a message's offer names, on a
 * public host, or at a test's stand-in on this machine. It carries no cookie, credential or
 * anything else that names the member, and follows no redirect, so it reaches that address alone.
 * An answer of 2xx means the sender took it. Anything else, a redirect included, says why not.
 */
export async function unsubscribeAt(
  address: string,
  post: Post,
  standIn?: string,
): Promise<Unsubscribed> {
  const url = new URL(address);
  const isStandIn = standIn !== undefined && url.origin === new URL(standIn).origin;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !(isStandIn || isPublicHost(url.hostname))
  ) {
    return { taken: false, reason: `Trail Mix unsubscribes only at public hosts over HTTPS.` };
  }
  let response: Response;
  try {
    response = await post(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
      body: 'List-Unsubscribe=One-Click',
      signal: AbortSignal.timeout(POST_MS),
    });
  } catch {
    return { taken: false, reason: `Trail Mix couldn’t reach ${url.host}.` };
  }
  await response.body?.cancel();
  if (response.ok) return { taken: true };
  if (response.status >= 300 && response.status < 400) {
    return {
      taken: false,
      reason: `${url.host} answered with a redirect, which a one-click unsubscribe doesn’t follow.`,
    };
  }
  const status = `${response.status} ${response.statusText}`.trim();
  return { taken: false, reason: `${url.host} answered ${status}.` };
}

/** The internet, as a Worker reaches it. */
export const internet: Post = (url, init) => fetch(url, init);

/** A raw message's header, as text: its bytes up to the first empty line. */
export function headerOf(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let at = bytes.indexOf(LF); at >= 0; at = bytes.indexOf(LF, at + 1)) {
    const next = bytes[at + 1] === CR ? at + 2 : at + 1;
    if (bytes[next] === LF || next >= bytes.length) {
      end = at + 1;
      break;
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

const LF = 0x0a;
const CR = 0x0d;

/** How long a sender's server has to answer. */
const POST_MS = 10_000;

/** Who the Mailroom says it is, so a sender can tell why it posts. */
const USER_AGENT = 'TrailMix (one-click unsubscribe; +https://github.com/lostintangent/trail-mix)';
