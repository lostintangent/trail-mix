import type { Address } from '../../mail/core/index.ts';

/**
 * The sender a conversation's row shows: its newest sender who isn't the member, by any of their
 * addresses, or the member when only they wrote. `senders` is newest first, and `selves` holds the
 * member's addresses in lower case.
 */
export function faceOf(
  senders: readonly Address[],
  selves: ReadonlySet<string>,
): Address | undefined {
  return senders.find(({ email }) => !selves.has(email.toLowerCase())) ?? senders[0];
}
