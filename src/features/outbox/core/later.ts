/**
 * The times Send later offers, and how a time to come reads, both on the device's clock and in its
 * time zone. The Mailroom receives the chosen time as an instant.
 */

const MORNING = 8;
const EVENING = 18;

export type Later = {
  label: 'In an hour' | 'This evening' | 'Tomorrow morning' | 'Monday morning';
  at: Date;
};

/**
 * What Send later offers at `now`: an hour from now, this evening while it is more than an hour off,
 * tomorrow morning, and on a Friday or Saturday, Monday morning.
 */
export function laterTimes(now: Date): Later[] {
  const day = (offset: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour);
  const hour = new Date(now.getTime() + 60 * 60_000);
  hour.setSeconds(0, 0);
  const evening = day(0, EVENING);
  const untilMonday = (8 - now.getDay()) % 7;
  return [
    { label: 'In an hour', at: hour },
    ...(evening.getTime() - now.getTime() > 60 * 60_000
      ? [{ label: 'This evening' as const, at: evening }]
      : []),
    { label: 'Tomorrow morning', at: day(1, MORNING) },
    ...(untilMonday > 1 && untilMonday < 4
      ? [{ label: 'Monday morning' as const, at: day(untilMonday, MORNING) }]
      : []),
  ];
}

/** How far ahead a time is, in calendar days on the device's clock. */
export type Ahead = 'today' | 'tomorrow' | 'week' | 'later';

export function aheadOf(at: Date, now: Date): Ahead {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return days < 7 ? 'week' : 'later';
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** A time to come as the Outbox shows it: "Today 5:00 PM", "Tomorrow 8:00 AM", "Mon 8:00 AM". */
export function formatAhead(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const day = {
    today: () => 'Today',
    tomorrow: () => 'Tomorrow',
    week: () => weekday.format(at),
    later: () => date.format(at),
  }[aheadOf(at, now)]();
  return `${day} ${time.format(at)}`;
}

/** A time picked in a local date and time field, such as "2026-11-10T17:00", as an instant. */
export function instantOf(local: string): string {
  return new Date(local).toISOString();
}
