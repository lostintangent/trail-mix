/**
 * What Members reads and changes: the Cloudflare Access policy that admits people to Trail
 * Mix. Each `email` rule in its Include list is a member. Every other rule stays as Access holds it,
 * and the page shows it in words, since Trail Mix can't change it. Nothing here keeps a copy of the
 * list: each read comes from Access.
 */

/** What a browser may ask about members. Everything but `isOperator` answers the operator alone. */
export interface Members {
  /** Whether the person asking is the operator. It names nobody else. */
  isOperator(): Promise<boolean>;
  /** Who the policy admits by address, and how else it admits people. */
  members(): Promise<MemberList>;
  invite(email: string): Promise<void>;
  /**
   * Takes them off the list, ends their sign-in and closes their open connections, then erases
   * what Trail Mix holds for them if asked. Safe to run again after any step failed.
   */
  remove(email: string, erase: boolean): Promise<void>;
}

export type Member = { email: string; operator: boolean; lastSeenAt?: string };

/** The members, and what else admits people, in words, for the page to show as it is. */
export type MemberList = { members: Member[]; alsoAdmitted: string[] };

/** One rule of an Access policy, as Cloudflare's API spells it. Only `email` rules are members. */
export type AccessRule = Record<string, unknown>;

/** An Access policy, with every field Cloudflare sent, so writing it back loses nothing. */
export type AccessPolicy = Record<string, unknown> & {
  id: string;
  decision?: string;
  include?: AccessRule[];
  exclude?: AccessRule[];
  require?: AccessRule[];
  /** A reusable policy stands on its own. Otherwise it belongs to one application. */
  reusable?: boolean;
};

/**
 * One person, however their address is capitalized: A to Z fold and nothing else, as sign-in
 * folds an address, so the list and sign-in always agree on who someone is.
 */
export const folded = (email: string) =>
  email.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const emailOf = (rule: AccessRule): string | undefined => {
  const inner = rule.email;
  if (typeof inner !== 'object' || inner === null || !('email' in inner)) return undefined;
  return typeof inner.email === 'string' ? folded(inner.email) : undefined;
};

/** The addresses a policy admits one by one, in its order, each once. */
export function addressesOf(policy: AccessPolicy): string[] {
  return [...new Set((policy.include ?? []).flatMap((rule) => emailOf(rule) ?? []))];
}

/**
 * Which of an application's policies is the member list: its one Allow policy that names the
 * operator. Anything else is said, not guessed, so the page edits nothing it isn't sure of.
 */
export function memberPolicy(
  policies: readonly AccessPolicy[],
  operator: string,
): { policy: AccessPolicy } | { problem: string } {
  const naming = policies.filter(
    (policy) => policy.decision === 'allow' && addressesOf(policy).includes(folded(operator)),
  );
  if (naming.length === 1) return { policy: naming[0]! };
  if (naming.length === 0) {
    return {
      problem: `No Allow policy of the Trail Mix application names ${operator}, so Trail Mix can’t tell which one lists its members.`,
    };
  }
  return {
    problem: `${naming.length} Allow policies of the Trail Mix application name ${operator}, so Trail Mix can’t tell which one lists its members.`,
  };
}

/** The list a page shows: each address, the operator marked, and every other rule in words. */
export function listOf(
  policy: AccessPolicy,
  operator: string,
  lastSeen: (email: string) => string | undefined,
): MemberList {
  const members = addressesOf(policy).map((email) => {
    const seen = lastSeen(email);
    return { email, operator: email === folded(operator), ...(seen ? { lastSeenAt: seen } : {}) };
  });
  const others = (policy.include ?? []).filter((rule) => emailOf(rule) === undefined);
  return {
    members,
    alsoAdmitted: [
      ...others.map(ruleSaid),
      ...(policy.require?.length ? ['Only people who also meet the policy’s Require rules'] : []),
      ...(policy.exclude?.length ? ['Except anyone the policy’s Exclude rules name'] : []),
    ],
  };
}

/** A rule Trail Mix doesn't change, as the page says it. */
export function ruleSaid(rule: AccessRule): string {
  if ('everyone' in rule)
    return 'Anyone with an email address. Cloudflare calls this a misconfiguration.';
  const domain = domainOf(rule);
  if (domain) return `Everyone at ${domain}`;
  if ('group' in rule) return 'Everyone in an Access group';
  if ('email_list' in rule) return 'Everyone on an Access email list';
  return `A ${Object.keys(rule)[0]?.replaceAll('_', ' ') ?? 'rule'} rule`;
}

const domainOf = (rule: AccessRule): string | undefined => {
  const inner = rule.email_domain;
  if (typeof inner !== 'object' || inner === null || !('domain' in inner)) return undefined;
  return typeof inner.domain === 'string' ? folded(inner.domain) : undefined;
};

/**
 * Who else the policy admits that takes in an address: anyone, or everyone at its domain. Groups
 * and lists can't be read from here, so an address may be admitted by one without the page knowing.
 */
export function stillAdmittedBy(policy: AccessPolicy, email: string): string[] {
  const domain = folded(email).split('@')[1];
  return (policy.include ?? []).flatMap((rule) => {
    if ('everyone' in rule) return ['anyone with an email address'];
    return domain !== undefined && domainOf(rule) === domain ? [`everyone at ${domain}`] : [];
  });
}

/** The policy with one more address, everything else as it was. */
export function withMember(policy: AccessPolicy, email: string): AccessPolicy {
  if (addressesOf(policy).includes(folded(email))) return policy;
  return { ...policy, include: [...(policy.include ?? []), { email: { email: folded(email) } }] };
}

/** The policy without an address, everything else as it was. */
export function withoutMember(policy: AccessPolicy, email: string): AccessPolicy {
  return {
    ...policy,
    include: (policy.include ?? []).filter((rule) => emailOf(rule) !== folded(email)),
  };
}

/** Why an address can't be invited, or nothing when it can. */
export function inviteProblem(policy: AccessPolicy, email: string): string | undefined {
  const address = folded(email);
  if (!ADDRESS.test(address)) return 'Enter the whole address, such as ada@example.com.';
  if (addressesOf(policy).includes(address)) return `${address} is already a member.`;
  const [admitted] = stillAdmittedBy(policy, address);
  if (admitted) return `${address} can already sign in, since the policy admits ${admitted}.`;
  return undefined;
}

/** Why an address can't be removed, or nothing when it can. */
export function removeProblem(email: string, operator: string): string | undefined {
  return folded(email) === folded(operator) ? 'You can’t remove yourself.' : undefined;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
