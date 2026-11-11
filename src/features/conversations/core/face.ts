import type { Address, ConversationSummary } from '../../mail/core/index.ts';

/**
 * Who a conversation stands for: its newest sender who isn't the member, by any of their
 * addresses, or the member when only they wrote. `senders` is newest first, and `selves` holds the
 * member's addresses in lower case.
 */
export function faceOf(
  senders: readonly Address[],
  selves: ReadonlySet<string>,
): Address | undefined {
  return senders.find(({ email }) => !selves.has(email.toLowerCase())) ?? senders[0];
}

/**
 * Whom a conversation's row names, and whose face it shows. It names its senders and shows the
 * newest who isn't the member. A conversation only the member wrote names whom it went to instead,
 * as "To Rae Chen", and shows the first of them, so a Sent folder reads as more than the member's
 * own name over and over. The member is passed over among them unless they wrote only to
 * themselves, and an address with no domain, such as an undisclosed group's, names no one. A
 * draft addressed to nobody yet has `names` of nothing, which the row says in its own words.
 */
export function peopleOf(
  { senders, recipients }: Pick<ConversationSummary, 'senders' | 'recipients'>,
  selves: ReadonlySet<string>,
): { names: string | undefined; face: Address | undefined } {
  const face = faceOf(senders, selves);
  if (face && !selves.has(face.email.toLowerCase())) return { names: namesOf(senders), face };
  const addressed = recipients.filter(({ email }) => hasDomain(email));
  const others = addressed.filter(({ email }) => !selves.has(email.toLowerCase()));
  const to = others[0] ? others : addressed;
  return to[0] ? { names: `To ${namesOf(to)}`, face: to[0] } : { names: undefined, face };
}

/** "Ada Park" for one person, and first names for several, in order. */
/**
 * Whether an address has a domain after its last `@`, as `domainOf` reads one. It's written out
 * here, since the module `domainOf` lives in carries the address-list parser, which the first
 * screen would then carry too.
 */
const hasDomain = (email: string) =>
  email.includes('@') && email.slice(email.lastIndexOf('@') + 1).trim() !== '';

function namesOf(people: readonly Address[]): string {
  const names = people.map(({ name, email }) => name || email);
  if (names.length <= 1) return names[0] ?? '';
  return names.map((name) => name.split(' ')[0]).join(', ');
}
