import type { AccessPolicy } from '../core/index.ts';

/**
 * Cloudflare's API, as far as the Members page reaches it: the Access application in front of
 * Trail Mix, its policies, each person's last sign-in, and ending someone's sessions. The token
 * is the operator's second one, which can do no more than this.
 */
export type CloudflareApi = ReturnType<typeof cloudflareApi>;

/** Where Cloudflare's API answers. Tests point a developer's deployment at a stand-in instead. */
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** A request Cloudflare refused, in Cloudflare's own words. */
export class CloudflareRefused extends Error {}

type Application = { id: string; aud?: string; policies?: AccessPolicy[] };

export function cloudflareApi({
  base = CLOUDFLARE_API,
  account,
  token,
  fetch: send = fetch,
}: {
  base?: string;
  account: string;
  token: string;
  fetch?: typeof fetch;
}) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await send(`${base}/accounts/${account}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Trail Mix',
        },
      });
    } catch {
      throw new CloudflareRefused('Trail Mix couldn’t reach Cloudflare’s API.');
    }
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: { code?: number; message?: string }[];
    };
    if (!response.ok || body.success === false) {
      const said = body.errors
        ?.map(({ message }) => message)
        .filter(Boolean)
        .join(' ');
      throw new CloudflareRefused(`Cloudflare refused it: ${said || `HTTP ${response.status}`}`);
    }
    return body.result as T;
  }

  return {
    /** The Access application whose audience tag Trail Mix checks, with its policies. */
    async application(audience: string): Promise<Application | undefined> {
      const apps = await call<Application[]>('/access/apps');
      const found = apps.find((app) => app.aud === audience);
      return found && call<Application>(`/access/apps/${found.id}`);
    },

    /** Writes a policy back whole: a reusable one on its own, or else as its application's. */
    async writePolicy(app: string, policy: AccessPolicy): Promise<AccessPolicy> {
      const path = policy.reusable
        ? `/access/policies/${policy.id}`
        : `/access/apps/${app}/policies/${policy.id}`;
      return call<AccessPolicy>(path, { method: 'PUT', body: JSON.stringify(policy) });
    },

    /** When someone last signed in to any of the account's Access applications. */
    async lastSignIn(email: string): Promise<string | undefined> {
      const users = await call<{ email?: string; last_successful_login?: string }[]>(
        `/access/users?email=${encodeURIComponent(email)}`,
      );
      return users.find((user) => user.email?.toLowerCase() === email)?.last_successful_login;
    },

    /** Ends every Access session someone holds, at once. */
    async revoke(email: string): Promise<void> {
      await call('/access/organizations/revoke_user', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },
  };
}
