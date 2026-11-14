import start from '@tanstack/react-start/server-entry';
import type { Mailroom, Timed } from '../features/mailroom/client/contract.ts';
import { readAvatarPath, readMessagePath } from '../features/mailroom/client/urls.ts';
import { CLOUDFLARE_API, cloudflareApi, membersFor } from '../features/members/server/index.ts';
import { signInFor, signsInDevelopers, type SignInConfig } from './access.ts';
import { demoImages, proxyImage } from './routes/images.ts';
import { serveAvatar, type AvatarBytes } from './routes/avatars.ts';
import { serveMessageBytes, type MessageBytes } from './routes/messages.ts';
import { act } from './routes/notifications.ts';
import { updates } from './routes/updates.ts';
import {
  gateOf,
  isChangeAllowed,
  tooManyChanges,
  type RateLimit,
  type VisitorGateEnv,
} from './visitors.ts';

export { Mailroom } from '../features/mailroom/server/index.ts';
export { VisitorGate } from './visitors.ts';

export type Env = Omit<SignInConfig, 'VISITOR_GATE'> &
  VisitorGateEnv & {
    /** One Mailroom per member, named by their verified email address. */
    MAILROOM: {
      idFromName(name: string): unknown;
      get(id: unknown): Mailroom & MessageBytes & AvatarBytes;
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
    /** The public demo's visitor gate, and its limit on each network's changes. Only the demo has them. */
    VISITORS?: Parameters<typeof gateOf>[0];
    VISITOR_CHANGES?: RateLimit;
  };

/** Whether this isolate has served a request yet. Its first one paid for starting it. */
let started = false;

/**
 * The Worker. Files from the build are served before it runs. Every other request passes the gate
 * below in order, and only a member's own pages, signed in, reach their Mailroom. The Mailroom is
 * named by the verified sign-in alone, and the app and the routes get the Mailroom, not the name.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const begun = performance.now();
    const isFirst = !started;
    started = true;
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ version: env.VERSION ?? 'development' });

    const signIn = signInFor({ ...env, VISITOR_GATE: env.VISITORS && gateOf(env.VISITORS) });
    if (!signIn) return setupPage(url);
    if (!isFromTrailMix(request)) return new Response('Forbidden', { status: 403 });
    const message = readMessagePath(url.pathname);
    const avatar = readAvatarPath(url.pathname);
    // Everything but the page and remote images reaches the member's Mailroom, which may make one.
    const reachesMailroom =
      url.pathname.startsWith('/_serverFn/') ||
      url.pathname === '/updates' ||
      url.pathname === '/notifications/act' ||
      message !== null ||
      avatar !== null;
    const signed = await signIn(request, { reachesMailroom });
    if (signed instanceof Response) return signed;
    const { member, setCookie, isLetIn = true } = signed;
    const answer = (response: Response) => withCookie(response, setCookie);
    if (reachesMailroom && !(await isChangeAllowed(env.VISITOR_CHANGES, request))) {
      return answer(tooManyChanges());
    }
    // The app's responses say where their time went, so a member's browser can show it.
    const timing: Timed[] = [
      ...(isFirst ? [{ name: 'isolate', note: 'The Worker started for this request' }] : []),
      { name: 'access', ms: performance.now() - begun },
    ];

    // A new stub each time it's reached, since one that threw stays broken. A visitor the demo's
    // gate hasn't let in reaches none, so no route, however it is reached, makes a Mailroom past it.
    const mailroom = () => {
      if (!isLetIn) throw new Error('The demo’s gate hasn’t let this visitor in.');
      return env.MAILROOM.get(env.MAILROOM.idFromName(member));
    };
    if (url.pathname === '/updates') return answer(await updates(request, mailroom()));
    if (message) return answer(await serveMessageBytes(message, mailroom()));
    if (avatar) return answer(await serveAvatar(avatar, mailroom()));
    if (url.pathname === '/images') {
      return answer(env.DEMO_MAILBOX ? demoImages(request) : await proxyImage(request));
    }
    if (url.pathname === '/notifications/act') return answer(await act(request, mailroom()));
    const response = await start.fetch(request, {
      context: {
        mailroom,
        members: membersOf(env, member),
        timing,
        waitUntil: (work) => ctx.waitUntil(work),
      },
    });
    return answer(
      withTiming(response, [...timing, { name: 'worker', ms: performance.now() - begun }]),
    );
  },
};

/**
 * A response that sets the cookie sign-in keeps, where it keeps one. A socket's upgrade goes as it
 * is, since its page set the cookie already.
 */
function withCookie(response: Response, setCookie: string | undefined): Response {
  if (!setCookie || response.status === 101) return response;
  const kept = new Response(response.body, response);
  kept.headers.append('Set-Cookie', setCookie);
  return kept;
}

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
 * Members' side for the signed-in member. It answers the operator alone, and only its
 * removal of a member names that member's Mailroom, as the rule "Every request is a member" allows.
 */
function membersOf(env: Env, member: string) {
  const { CLOUDFLARE_ACCOUNT_ID: account, ACCESS_API_TOKEN: token } = env;
  const base = signsInDevelopers(env) && env.CLOUDFLARE_API ? env.CLOUDFLARE_API : CLOUDFLARE_API;
  return membersFor({
    caller: member,
    operator: env.OPERATOR_EMAIL,
    audience: env.ACCESS_AUD?.trim(),
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
    ? '<p>To sign in while developing, copy <code>dev.vars.example</code> to <code>.dev.vars</code> and restart.</p>'
    : `<ol>
<li>In Cloudflare Zero Trust, add a self-hosted Access application for <code>${escapeHtml(url.hostname)}</code> that lets your email address in with a one-time PIN.</li>
<li>In this Worker's settings, under Variables and Secrets, add <code>ACCESS_TEAM_DOMAIN</code>, your team domain, and <code>ACCESS_AUD</code>, the application's Audience (AUD) tag. Then reload this page.</li>
</ol>
<p><a href="${SETUP_STEPS}">Trail Mix's README</a> walks through both, step by step.</p>`;
  const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Trail Mix isn’t set up yet</title>
<body style="font-family: system-ui; max-width: 36rem; margin: 4rem auto; padding: 0 1rem">
<h1>Trail Mix isn’t set up yet</h1>
<p>It stays closed until it can check who is signing in.</p>
${next}
</body>
</html>`;
  return new Response(page, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Where the setup page sends an operator: the README's steps for signing in with Access. */
const SETUP_STEPS = 'https://github.com/lostintangent/trail-mix#2-sign-in-with-cloudflare-access';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
