import type { Mailroom } from '../../features/mailroom/client/contract.ts';

/**
 * The hint socket. The upgrade goes to the signed-in member's Mailroom, which holds the socket and
 * sends hints on it. The Mailroom gets the upgrade alone, without the request's headers, cookies
 * or query, so nothing a browser sent can name anyone to it.
 */
export function updates(request: Request, mailroom: Pick<Mailroom, 'fetch'>): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Promise.resolve(
      new Response('Hints arrive on a WebSocket.', {
        status: 426,
        headers: { Upgrade: 'websocket' },
      }),
    );
  }
  const upgrade = new Request(new URL('/updates', request.url), {
    headers: { Upgrade: 'websocket' },
  });
  return mailroom.fetch(upgrade);
}
