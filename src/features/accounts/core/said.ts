import type { Account } from '../../mail/core/index.ts';

/**
 * What the account screens say about what the Mailroom does: what removing an account takes with
 * it, and why an account couldn't be added.
 */

/**
 * The question before an account is removed. Trail Mix forgets everything it stored for it, while
 * the mail stays on the server, except a demo account's, whose mail Trail Mix holds itself. Sends
 * waiting in the Outbox are forgotten too, and their drafts stay where they are.
 */
export function removeSaid(account: Account, waiting: number): string {
  const forgets =
    account.provider === 'demo'
      ? `${account.name} is part of the demo mailbox, so its mail goes with it.`
      : `Trail Mix forgets ${account.name}: the index of its mail, the copies of messages you opened, and its password. The mail stays on its server, and you can add the account again.`;
  if (waiting === 0) return forgets;
  const sends = waiting === 1 ? '1 message waiting' : `${waiting} messages waiting`;
  return `${forgets} ${sends} in the Outbox won’t be sent, and ${waiting === 1 ? 'stays' : 'stay'} in Drafts.`;
}

/**
 * The question before a member erases everything Trail Mix holds for them. It forgets every account
 * with how it signs in, the index of their mail, the copies of messages they opened and what waits
 * in the Outbox. The mail stays on its servers, except the demo mailbox's, which Trail Mix holds.
 */
export function eraseSaid(accounts: readonly Account[], waiting: number): string {
  const own = accounts.filter(({ provider }) => provider !== 'demo');
  const said = [
    own.length > 0
      ? `Trail Mix forgets ${listed(own.map(({ name }) => name))}: the index of ${own.length === 1 ? 'its' : 'their'} mail, the copies of messages you opened, and how it signs in to ${own.length === 1 ? 'it' : 'them'}.`
      : '',
    own.length < accounts.length ? 'The demo mailbox goes, with all its mail.' : '',
    accounts.length === 0 ? 'Trail Mix forgets everything it holds for you.' : '',
    waiting > 0
      ? `${waiting === 1 ? '1 message' : `${waiting} messages`} waiting in the Outbox won’t be sent.`
      : '',
    own.length > 0 ? 'Your mail stays on its servers, and you can add your accounts again.' : '',
    'Every device you’re signed in on starts over.',
  ];
  return said.filter(Boolean).join(' ');
}

/** Names as a sentence lists them: "A", "A and B", or "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The Mailroom's refusal for a deployment that holds the demo mailbox. */
const DEMO_ONLY = 'This deployment has only the demo mailbox.';

/**
 * Whether this Trail Mix holds the demo mailbox, which only a preview or the public demo does, and
 * which never connects a real account. It shows in the accounts it already has.
 */
export const isDemoOnly = (accounts: readonly Account[]) =>
  accounts.some(({ provider }) => provider === 'demo');

/** Why an account wasn't added. A host's own words come through as the Mailroom gave them. */
export function refusalSaid(message: string): string {
  if (message === DEMO_ONLY) return DEMO_SAID;
  return message;
}

export const DEMO_SAID =
  'This Trail Mix serves only the demo mailbox, so it can’t connect an account of your own.';

/** What the public demo says of itself, where a visitor might look to change what it holds. */
export const VISITOR_SAID = {
  invitation:
    'This is Trail Mix’s demo, a sample mailbox that’s yours for a day. To read your own mail, deploy a Trail Mix of your own and add your accounts there.',
  keeps: 'The demo keeps its two accounts.',
  erases: 'The demo erases everything it holds for you a day after your last visit.',
} as const;

/**
 * Why a member can't sign in at a vendor here: the operator hasn't registered Trail Mix with it. The
 * Mailroom says the same when asked to sign in anyway.
 */
export const signInNotSetUp = (vendor: string, setting: string) =>
  `${vendor} sign-in isn’t set up on this Trail Mix. The operator registers an app with ${vendor} and sets ${setting}.`;
