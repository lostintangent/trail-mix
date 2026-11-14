/**
 * How long a Mailroom keeps working for a member who stopped opening it. It is opened when a
 * signed-in device asks it for something: a query, a command, the hint socket or a message's bytes.
 * Its own alarm, sync and sends don't count, and nor does a notification it sends. Unopened for a
 * while, it rests: it stops checking mail and sleeps, and opening it again picks up from the stored
 * cursors. Unopened for longer, it erases itself.
 */

const DAY_MS = 24 * 60 * 60_000;

/** How long unopened before a Mailroom rests, and before it erases itself. */
export type WindDown = { restsAfterMs: number; erasesAfterMs: number };

/** A member's Mailroom rests after 30 days unopened, and erases itself after 90. */
export const MEMBER_WIND_DOWN: WindDown = {
  restsAfterMs: 30 * DAY_MS,
  erasesAfterMs: 90 * DAY_MS,
};

/**
 * The wind-down a deployment sets in whole days, such as the public demo's, which erases each
 * visitor's Mailroom after a day. Either one left unset is a member's.
 */
export function windDownOf(restDays?: string, eraseDays?: string): WindDown {
  const days = (name: string, value: string | undefined, otherwise: number) => {
    if (value === undefined || value === '') return otherwise;
    if (!/^[1-9]\d{0,4}$/.test(value)) {
      throw new Error(`${name} must be a whole number of days, not ${JSON.stringify(value)}.`);
    }
    return Number(value) * DAY_MS;
  };
  const windDown = {
    restsAfterMs: days('REST_AFTER_DAYS', restDays, MEMBER_WIND_DOWN.restsAfterMs),
    erasesAfterMs: days('ERASE_AFTER_DAYS', eraseDays, MEMBER_WIND_DOWN.erasesAfterMs),
  };
  if (windDown.restsAfterMs > windDown.erasesAfterMs) {
    throw new Error('REST_AFTER_DAYS can be no more than ERASE_AFTER_DAYS.');
  }
  return windDown;
}

/**
 * How often an opening is written down. Days decide what happens, so an hour is close enough, and
 * a member reading mail doesn't write to storage with every request.
 */
const NOTED_EVERY_MS = 60 * 60_000;

/** Where a Mailroom stands, by how long since it was last opened. */
type Idleness = 'open' | 'resting' | 'erasing';

export function idlenessOf(openedAt: number, now: number, windDown: WindDown): Idleness {
  const unopened = now - openedAt;
  if (unopened >= windDown.erasesAfterMs) return 'erasing';
  if (unopened >= windDown.restsAfterMs) return 'resting';
  return 'open';
}

/** When a resting Mailroom next needs to wake on its own: to erase itself. */
export const erasesAt = (openedAt: number, windDown: WindDown) => openedAt + windDown.erasesAfterMs;

/** Whether an opening at `now` is worth writing down, given the one written last. */
export const isWorthNoting = (openedAt: number, now: number) => now - openedAt >= NOTED_EVERY_MS;
