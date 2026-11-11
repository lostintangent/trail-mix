import type { Answered, Call, CommandName } from '../../features/mailroom/client/contract.ts';

/**
 * `POST /notifications/act` carries a notification's buttons, Archive and Mark read, from the
 * service worker to the signed-in member's Mailroom, as the commands a page would send. It sits
 * behind sign-in like every route. When the sign-in has lapsed, Access answers with a redirect
 * before this runs, and the service worker opens the conversation instead.
 */

/** What a button asks, as JSON: `{ action: 'archive' | 'read', message: MessageRef }`. */
type Act = { action: 'archive' | 'read'; message: unknown };

export async function act(
  request: Request,
  mailroom: { answer(call: Call<CommandName>, sentAt: number): Promise<Answered> },
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('A notification’s button is a POST.', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }
  const asked = (await request.json().catch(() => undefined)) as Partial<Act> | undefined;
  const call = callFor(asked);
  if (!call) return new Response('A button archives a message or marks it read.', { status: 400 });
  try {
    await mailroom.answer(call, Date.now());
    return new Response(null, { status: 204 });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 409 });
  }
}

/** The command a button stands for, which checks its message as any command does. */
function callFor(asked: Partial<Act> | undefined): Call<CommandName> | undefined {
  if (asked?.message === undefined) return undefined;
  if (asked.action === 'archive') return { name: 'move', args: [[asked.message], 'archive'] };
  if (asked.action === 'read') return { name: 'setFlags', args: [[asked.message], { seen: true }] };
  return undefined;
}
