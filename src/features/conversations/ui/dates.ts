/** How long ago a date was, as a list tells it: today, yesterday, in the last week, this year, or before. */
export type DateDistance = 'today' | 'yesterday' | 'week' | 'year' | 'older';

/**
 * Counted in calendar days on the device's clock, so 11pm is yesterday by 1am. A date still to
 * come, from a sender's wrong clock, reads as a date rather than a time today.
 */
export function dateDistance(date: Date, now: Date): DateDistance {
  const days = calendarDaysBetween(date, now);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days > 1 && days < 7) return 'week';
  return date.getFullYear() === now.getFullYear() ? 'year' : 'older';
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayInYear = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const FORMATS: Record<DateDistance, (date: Date) => string> = {
  today: (date) => time.format(date),
  yesterday: () => 'Yesterday',
  week: (date) => weekday.format(date),
  year: (date) => day.format(date),
  older: (date) => dayInYear.format(date),
};

/** A conversation's date as a list shows it, in the device's time zone and language. */
export function formatListDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return FORMATS[dateDistance(date, now)](date);
}

/** Midnights crossed from `from` to `to`, whatever daylight saving does to the hours between. */
function calendarDaysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
