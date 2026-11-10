const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayInYear = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/**
 * A conversation's date as a list shows it, in the device's time zone: the time today, then
 * "Yesterday", the weekday within the last week, the day this year, and the full date before that.
 */
export function formatListDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = calendarDaysBetween(date, now);
  if (days <= 0) return time.format(date);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekday.format(date);
  return date.getFullYear() === now.getFullYear() ? day.format(date) : dayInYear.format(date);
}

/** Midnights crossed from `from` to `to`, so 11pm to 1am is one day and 1am to 11pm is none. */
function calendarDaysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
