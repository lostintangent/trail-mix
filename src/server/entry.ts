import start from '@tanstack/react-start/server-entry';
import type { Mailroom, Timed } from '../features/mailroom/client/contract.ts';
import { readLogoPath, readMessagePath } from '../features/mailroom/client/urls.ts';
import { CLOUDFLARE_API, cloudflareApi, membersFor } from '../features/members/server/index.ts';
import { signInFor, signsInDevelopers, type SignInConfig } from './access.ts';
import { proxyImage } from './routes/images.ts';
import { serveLogo, type LogoBytes } from './routes/logos.ts';
import { serveMessageBytes, type MessageBytes } from './routes/messages.ts';
import { act } from './routes/notifications.ts';
import { updates } from './routes/updates.ts';

export { Mailroom } from '../features/mailroom/server/index.ts';

export type Env = SignInConfig & {
  /** One Mailroom per member, named by their verified email address. */
  MAILROOM: {
    idFromName(name: string): unknown;
    get(id: unknown): Mailroom & MessageBytes & LogoBytes;
  };
  /** The commit this deployment runs. */
  VERSION?: string;
  /** Who manages members. Without it, nobody does. */
  OPERATOR_EMAIL?: string;
  /** The account Access belongs to, and the operator's token that edits its member list. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  ACCESS_API_TOKEN?: string;
  /** A stand-in for Cloudflare's API, which only a developer's own deployment heeds. */
  CLOUDFLARE_API?: string;
};

/** Whether this isolate has served a request yet. Its first one paid for starting it. */
let started = false;

/**
 * The Worker. Files from the build are served before it runs. Every other request passes the gate
 * below in order, and only a member's own pages, signed in, reach their Mailroom. The Mailroom is
 * named by the verified sign-in alone, and the app and the routes get the Mailroom, not the name.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const begun = performance.now();
    const isFirst = !started;
    started = true;
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ version: env.VERSION ?? 'development' });

    const signIn = signInFor(env);
    if (!signIn) return setupPage(url);
    if (!isFromTrailMix(request)) return new Response('Forbidden', { status: 403 });
    const member = await signIn(request);
    if (!member) return new Response('Sign in through Cloudflare Access.', { status: 401 });
    // The app's responses say where their time went, so a member's browser can show it.
    const timing: Timed[] = [
      ...(isFirst ? [{ name: 'isolate', note: 'The Worker started for this request' }] : []),
      { name: 'access', ms: performance.now() - begun },
    ];

    // A new stub each time it's reached, since one that threw stays broken.
    const mailroom = () => env.MAILROOM.get(env.MAILROOM.idFromName(member));
    if (url.pathname === '/updates') return updates(request, mailroom());
    const message = readMessagePath(url.pathname);
    if (message) return serveMessageBytes(message, mailroom());
    const logo = readLogoPath(url.pathname);
    if (logo) return serveLogo(logo, mailroom());
    if (url.pathname === '/images') return proxyImage(request);
    if (url.pathname === '/notifications/act') return act(request, mailroom());
    const response = await start.fetch(request, {
      context: {
        mailroom,
        members: membersOf(env, member),
        timing,
      },
    });
    return withTiming(response, [...timing, { name: 'worker', ms: performance.now() - begun }]);
  },
};

/**
 * A response with a Server-Timing header of the parts of its time. On Cloudflare a clock stands
 * still while code runs, so each part counts waiting, such as on the network or the Mailroom.
 */
function withTiming(response: Response, timing: readonly Timed[]): Response {
  const timed = new Response(response.body, response);
  timed.headers.set(
    'Server-Timing',
    timing
      .map(({ name, ms, note }) =>
        [
          name,
          ...(ms === undefined ? [] : [`dur=${Math.round(ms * 10) / 10}`]),
          ...(note === undefined ? [] : [`desc="${note.replace(/["\\]/g, '')}"`]),
        ].join(';'),
      )
      .join(', '),
  );
  return timed;
}

/**
 * The Members page's side for the signed-in member. It answers the operator alone, and only its
 * removal of a member names that member's Mailroom, as the rule "Every request is a member" allows.
 */
function membersOf(env: Env, member: string) {
  const { CLOUDFLARE_ACCOUNT_ID: account, ACCESS_API_TOKEN: token } = env;
  const base = signsInDevelopers(env) && env.CLOUDFLARE_API ? env.CLOUDFLARE_API : CLOUDFLARE_API;
  return membersFor({
    caller: member,
    operator: env.OPERATOR_EMAIL,
    audience: env.ACCESS_AUD,
    api: account && token ? cloudflareApi({ base, account, token }) : undefined,
    mailroomOf: (removed) => env.MAILROOM.get(env.MAILROOM.idFromName(removed)),
  });
}

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
