import {
  addressesOf,
  folded,
  inviteProblem,
  listOf,
  memberPolicy,
  removeProblem,
  stillAdmittedBy,
  withMember,
  withoutMember,
  type AccessPolicy,
  type Members,
} from '../core/index.ts';
import type { CloudflareApi } from './cloudflare.ts';

/** What the Worker may do to a member's Mailroom while the operator removes them, and only then. */
type Departing = { closeDevices(): Promise<void>; eraseEverything(): Promise<void> };

/** Asked of anyone but the operator. */
export class NotTheOperator extends Error {
  constructor() {
    super('Only the operator can manage members.');
  }
}

/**
 * Members' server side, for one verified caller. Every answer but `isOperator` is the
 * operator's alone, refused for anyone else before Cloudflare or any Mailroom is reached. Only
 * removing a member names their Mailroom, to close their connections and, if asked, erase it.
 */
export function membersFor({
  caller,
  operator,
  audience,
  api,
  mailroomOf,
}: {
  /** The address sign-in verified for this request. */
  caller: string;
  /** The deployment's `OPERATOR_EMAIL`. Without one, nobody is the operator. */
  operator: string | undefined;
  /** The audience tag of the Access application in front of Trail Mix. */
  audience: string | undefined;
  /** Cloudflare's API, with the operator's member-list token, or nothing when it isn't set. */
  api: CloudflareApi | undefined;
  mailroomOf: (member: string) => Departing;
}): Members {
  const isOperator = operator !== undefined && folded(caller) === folded(operator);

  /** The application and its member policy, read now, or why they can't be. */
  async function current(): Promise<{
    api: CloudflareApi;
    operator: string;
    app: string;
    policy: AccessPolicy;
  }> {
    if (!isOperator || operator === undefined) throw new NotTheOperator();
    if (!api || !audience) {
      throw new Error(
        'This Trail Mix has no member-list token, so its members are managed in the Cloudflare dashboard.',
      );
    }
    const app = await api.application(audience);
    if (!app)
      throw new Error('Cloudflare has no Access application with Trail Mix’s audience tag.');
    const found = memberPolicy(app.policies ?? [], operator);
    if ('problem' in found) throw new Error(found.problem);
    return { api, operator, app: app.id, policy: found.policy };
  }

  /** Writes a change, then reads the list again, and says it's done only once the list shows it. */
  async function change(
    write: (policy: AccessPolicy) => AccessPolicy,
    isShown: (addresses: string[]) => boolean,
  ) {
    const { api, app, policy } = await current();
    await api.writePolicy(app, write(policy));
    if (!isShown(addressesOf((await current()).policy))) {
      throw new Error('Cloudflare took the change, but its member list doesn’t show it yet.');
    }
  }

  return {
    isOperator: () => Promise.resolve(isOperator),

    async members() {
      const { api, operator, policy } = await current();
      const addresses = addressesOf(policy);
      // A last sign-in Cloudflare can't give is shown as unknown, never as a failed list.
      const seen = new Map(
        await Promise.all(
          addresses.map(
            async (email) => [email, await api.lastSignIn(email).catch(() => undefined)] as const,
          ),
        ),
      );
      return listOf(policy, operator, (email) => seen.get(email));
    },

    async invite(email) {
      const { policy } = await current();
      const problem = inviteProblem(policy, email);
      if (problem) throw new Error(problem);
      const address = folded(email);
      await change(
        (held) => withMember(held, address),
        (addresses) => addresses.includes(address),
      );
    },

    async remove(email, erase) {
      const { api, operator, policy } = await current();
      const address = folded(email);
      const problem = removeProblem(address, operator);
      if (problem) throw new Error(problem);
      // Off the list first, so nothing that follows can let them back in.
      if (addressesOf(policy).includes(address)) {
        await change(
          (held) => withoutMember(held, address),
          (addresses) => !addresses.includes(address),
        );
      }
      try {
        await api.revoke(address);
      } catch (error) {
        throw new Error(
          `${address} is off the list, but Trail Mix couldn’t end their sign-in, so they may stay signed in until their session ends. ${reasonOf(error)}`,
          { cause: error },
        );
      }
      // A connection opened before the revoke stays open, so their Mailroom closes it.
      const mailroom = mailroomOf(address);
      try {
        await mailroom.closeDevices();
        if (erase) await mailroom.eraseEverything();
      } catch (error) {
        throw new Error(
          `${address} is off the list and signed out, but Trail Mix couldn’t ${erase ? 'close their connections and erase what it holds for them' : 'close their connections'}. ${reasonOf(error)}`,
          { cause: error },
        );
      }
      const [admitted] = stillAdmittedBy(policy, address);
      if (admitted) {
        throw new Error(
          `${address} is off the list, but can still sign in, since the policy admits ${admitted}. Change that in the Cloudflare dashboard.`,
        );
      }
    },
  };
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
