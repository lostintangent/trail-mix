import {
  QUERIES,
  type Call,
  type CommandName,
  type Mailroom,
  type QueryName,
  type Timed,
} from './contract.ts';

/**
 * How the Worker asks the member's Mailroom a browser's query or command, on the server side of
 * `rpc.ts`'s two server functions.
 *
 * Cloudflare already sends a call again when it never reached the Mailroom. A call that reached it
 * and then failed, as when a deploy restarts the Mailroom mid-call, comes back as an error marked
 * `retryable`. Those are asked again, through a new stub, since a stub that threw stays broken, but
 * only for a call that a second run leaves as the first did. An `overloaded` Mailroom is never
 * asked again, since that would only add to its load.
 */
export async function ask(
  { mailroom, timing }: { mailroom: () => Mailroom; timing: Timed[] },
  call: Call<QueryName | CommandName>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await once(mailroom(), call, timing);
    } catch (error) {
      const delay = RETRY_WAITS_MS[attempt];
      if (delay === undefined || !isPassing(error) || !REPEATABLE.has(call.name)) throw error;
      // Jittered, so devices a deploy cut off at once don't all ask again at once.
      const waited = delay * (0.5 + Math.random() / 2);
      timing.push({ name: 'retried', ms: waited, note: 'The Mailroom failed for a moment' });
      await wait(waited);
    }
  }
}

/** How long each retry waits, before jitter: about a second and a quarter in all, at most. */
const RETRY_WAITS_MS = [250, 1000];

/** The queries, and the commands a second run leaves as the first did, answering the same. */
const REPEATABLE: ReadonlySet<string> = new Set<QueryName | CommandName>([
  ...QUERIES,
  'updateAccount',
  'allowImages',
  'setLightPaper',
  // A sender asked again to unsubscribe the same address is left as the first ask left it.
  'unsubscribe',
  'setFlags',
  'send',
  'deleteFolder',
  'eraseEverything',
]);

/** Whether Cloudflare says a failure may pass, and that asking again won't add to a load. */
function isPassing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { retryable, overloaded } = error as { retryable?: unknown; overloaded?: unknown };
  return retryable === true && overloaded !== true;
}

/**
 * Asks once, and notes for the response's Server-Timing how long the Mailroom took as the Worker
 * saw it, and how much of that was reaching it, running there and coming back, and whether it had
 * to start first. Coming back counts an answer the Mailroom holds until what it wrote is safely
 * stored, as Cloudflare holds every answer a Durable Object sends. Names and times only, never
 * what a call carried.
 */
async function once(mailroom: Mailroom, call: Call<QueryName | CommandName>, timing: Timed[]) {
  const sent = Date.now();
  const at = performance.now();
  const noted = timing.length;
  try {
    const { value, reached, ran, cold } = await mailroom.answer(call, sent);
    const took = performance.now() - at;
    timing.push(
      { name: 'reached', ms: Math.max(0, reached) },
      { name: 'ran', ms: ran },
      { name: 'returned', ms: Math.max(0, took - Math.max(0, reached) - ran) },
      ...(cold ? [{ name: 'cold', note: 'The Mailroom started for this call' }] : []),
    );
    return value;
  } finally {
    timing.splice(noted, 0, { name: 'mailroom', ms: performance.now() - at, note: call.name });
  }
}
