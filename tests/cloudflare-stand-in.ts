/**
 * A stand-in for the parts of Cloudflare's API Members reaches: the Access applications,
 * one member policy, each person's last sign-in, and revoking someone's sessions. It answers in
 * Cloudflare's envelope, records every call, and can refuse any of them as Cloudflare would.
 */

export type StandInCall = { method: string; path: string; body?: unknown };

export const STAND_IN_AUD = 'a'.repeat(64);

export function cloudflareStandIn({
  account = 'account',
  members = ['ada@example.com'],
  alsoInclude = [] as Record<string, unknown>[],
  reusable = true,
}: {
  account?: string;
  members?: string[];
  alsoInclude?: Record<string, unknown>[];
  reusable?: boolean;
} = {}) {
  const calls: StandInCall[] = [];
  const lastSeen = new Map<string, string>();
  /** Paths Cloudflare refuses, with the message it gives. */
  const refusing = new Map<string, string>();
  /** Whether a policy written is taken but not yet shown, as an eventually consistent API may. */
  const lagging = { writes: false };
  let policy: Record<string, unknown> & { include: Record<string, unknown>[] } = {
    id: 'policy-1',
    name: 'Trail Mix members',
    decision: 'allow',
    reusable,
    session_duration: '24h',
    include: [...members.map((email) => ({ email: { email } })), ...alsoInclude],
    exclude: [],
    require: [],
  };
  const app = {
    id: 'app-1',
    aud: STAND_IN_AUD,
    name: 'Trail Mix',
    get policies() {
      return [policy, { id: 'bypass', decision: 'bypass', include: [{ everyone: {} }] }];
    },
  };

  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const refused = (message: string) =>
    Response.json(
      { success: false, errors: [{ code: 10000, message }], result: null },
      {
        status: 403,
      },
    );

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*\/accounts\/[^/]+/, '');
    const body: unknown =
      request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
    calls.push({ method: request.method, path: `${path}${url.search}`, body });
    if (!url.pathname.includes(`/accounts/${account}/`)) return refused('No such account.');
    for (const [refusedPath, message] of refusing) {
      if (path.startsWith(refusedPath)) return refused(message);
    }
    if (request.method === 'GET' && path === '/access/apps') return ok([app]);
    if (request.method === 'GET' && path === `/access/apps/${app.id}`) return ok(app);
    const policyPath = reusable
      ? `/access/policies/${String(policy.id)}`
      : `/access/apps/${app.id}/policies/${String(policy.id)}`;
    if (request.method === 'PUT' && path === policyPath) {
      if (!lagging.writes) policy = body as typeof policy;
      return ok(body);
    }
    if (request.method === 'GET' && path === '/access/users') {
      const email = url.searchParams.get('email') ?? '';
      const seen = lastSeen.get(email);
      return ok(seen ? [{ email, last_successful_login: seen }] : []);
    }
    if (request.method === 'POST' && path === '/access/organizations/revoke_user') {
      return ok(true);
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: 'No route.' }] },
      {
        status: 404,
      },
    );
  }

  return {
    handle,
    calls,
    lastSeen,
    refusing,
    lagging,
    get policy() {
      return policy;
    },
    /** The addresses the policy admits one by one. */
    get members() {
      return policy.include.flatMap((rule) => {
        const inner = rule.email as { email?: string } | undefined;
        return inner?.email ? [inner.email] : [];
      });
    },
  };
}
