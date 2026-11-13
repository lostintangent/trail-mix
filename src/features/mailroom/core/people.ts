import { domainOf, type Envelope, type FolderRole } from '../../mail/core/index.ts';
import { senderOf } from './avatars.ts';

/**
 * Whom the composer completes To, Cc and Bcc with: the people the member's mail puts them in touch
 * with. A message the member sent puts them in touch with each person it went to, and anyone
 * else's with its sender. Those the member wrote to come ahead of those who only wrote to them.
 *
 * A message counts for nobody while it is a draft or junk, since neither was ever between the
 * member and anyone. Mail from a list or from an address nobody reads, such as a no-reply one,
 * speaks for no person the member would write to, so it puts them in touch with nobody, and its
 * sender completes only once the member writes to them. The member is never among the people they
 * complete.
 */

/** One person a message puts the member in touch with, by address, and the name it gives them. */
export type Correspondent = {
  /** In lowercase, which is how each person is counted once. */
  address: string;
  /** Empty when the message gives none. */
  name: string;
  /** Whether the member wrote to them, or else they wrote to the member. */
  wrote: boolean;
};

/**
 * The people a message puts the member in touch with, once each, given the member's addresses in
 * lowercase as `mine` and the role of the folder it is in.
 */
export function correspondentsOf(
  { from, to, cc, list }: Pick<Envelope, 'from' | 'to' | 'cc' | 'list'>,
  mine: ReadonlySet<string>,
  role: FolderRole | undefined,
): Correspondent[] {
  if (role === 'drafts' || role === 'junk') return [];
  const sender = senderOf(from.email);
  const wrote = mine.has(sender);
  if (!wrote && (list || isNoReply(sender))) return [];
  const people = new Map<string, Correspondent>();
  for (const { name, email } of wrote ? [...to, ...cc] : [from]) {
    const address = senderOf(email);
    if (!domainOf(address) || mine.has(address)) continue;
    const named = nameOf(name, address);
    const held = people.get(address);
    if (!held) people.set(address, { address, name: named, wrote });
    else if (!held.name) held.name = named;
  }
  return [...people.values()];
}

/**
 * Whether an address says that nobody reads what is sent to it: a no-reply one in any of the
 * shapes senders write it, alone or within a longer name, or a mail server's own.
 */
export function isNoReply(address: string): boolean {
  const at = address.lastIndexOf('@');
  const local = (at < 0 ? address : address.slice(0, at)).toLowerCase();
  return NO_REPLY.test(local) || local === 'mailer-daemon';
}

/**
 * "noreply", "no-reply", "donotreply", "do_not_reply", "dont.reply" and the like, as a word of the
 * local part, which a mark, a `+` tag or digits may follow, as in "notifications-noreply" or
 * "noreply+receipts".
 */
const NO_REPLY = /(?:^|[-_.+])(?:no|do[-_.]?not|dont)[-_.]?reply(?:$|[-_.+0-9])/;

/** The name a message gives someone, or none when it only repeats their address. */
function nameOf(name: string | undefined, address: string): string {
  const named = name?.trim() ?? '';
  return named.toLowerCase() === address ? '' : named;
}
