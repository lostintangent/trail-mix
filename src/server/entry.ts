import start from '@tanstack/react-start/server-entry';
import type { Mailroom } from '../features/mailroom/client/index.ts';
import { signInFor, type SignInConfig } from './access.ts';
import { updates } from './routes/updates.ts';

declare module '@tanstack/react-start' {
  interface Register {
    server: {
      /** Each request's signed-in member's Mailroom, which server functions call. */
      requestContext: { mailroom: Mailroom };
    };
  }
}

export type Env = SignInConfig & {
  /** One Mailroom per member, named by their verified email address. */
  MAILROOM: { idFromName(name: string): unknown; get(id: unknown): Mailroom };
  /** The commit this deployment runs. */
  VERSION?: string;
};

/**
 * The Worker. Files from the build are served before it runs. Every other request passes the gate
 * below in order, and only a member's own pages, signed in, reach their Mailroom. The Mailroom is
 * named by the verified sign-in alone, and the app and the routes get the Mailroom, not the name.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ version: env.VERSION ?? 'development' });

    const signIn = signInFor(env);
    if (!signIn) return setupPage(url);
    if (!isFromTrailMix(request)) return new Response('Forbidden', { status: 403 });
    const member = await signIn(request);
    if (!member) return new Response('Sign in through Cloudflare Access.', { status: 401 });

    const mailroom = env.MAILROOM.get(env.MAILROOM.idFromName(member));
    if (url.pathname === '/updates') return updates(request, mailroom);
    return start.fetch(request, { context: { mailroom } });
  },
};

/**
 * Whether a request that changes something, or opens the hint socket, came from Trail Mix's own
 * pages. A browser attaches the member's sign-in to requests other sites start, too.
 */
function isFromTrailMix(request: Request): boolean {
  const isSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  if ((request.method === 'GET' || request.method === 'HEAD') && !isSocket) return true;
  const site = request.headers.get('Sec-Fetch-Site');
  if (site !== null) return site === 'same-origin';
  return request.headers.get('Origin') === new URL(request.url).origin;
}

/** Until the operator configures sign-in, the deployment serves this page and nothing else. */
function setupPage(url: URL): Response {
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const next = isLocal
    ? 'To sign in while developing, copy <code>.dev.vars.example</code> to <code>.dev.vars</code> and restart.'
    : 'Put Cloudflare Access in front of this Worker, then set <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code>. The README walks through it.';
  const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Trail Mix isn’t set up yet</title>
<body style="font-family: system-ui; max-width: 36rem; margin: 4rem auto; padding: 0 1rem">
<h1>Trail Mix isn’t set up yet</h1>
<p>It stays closed until it can check who is signing in.</p>
<p>${next}</p>
</body>
</html>`;
  return new Response(page, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
