import { readMessagePath } from '../../src/features/mailroom/client/urls.ts';
import testWorker, { TestMailroom } from '../../src/features/mailroom/server/test-worker.ts';
import { serveMessageBytes } from '../../src/server/routes/messages.ts';

export { TestMailroom };

type Env = Parameters<typeof testWorker.fetch>[1];

/**
 * The Mailroom's test Worker, plus the route that serves a message's bytes, as the app's Worker
 * serves it: `/<member>/messages/<ref>` reaches that member's Mailroom over its real stub.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, member, ...rest] = url.pathname.split('/');
    const message = readMessagePath(`/${rest.join('/')}`);
    if (!member || !message) return testWorker.fetch(request, env);
    return serveMessageBytes(message, env.MAILROOM.get(env.MAILROOM.idFromName(member)));
  },
};
