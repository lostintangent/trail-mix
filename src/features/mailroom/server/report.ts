/** Logs what went wrong in the Mailroom's own work, which no call is waiting to hear. */
export function report(error: unknown) {
  console.error('Mailroom:', error instanceof Error ? error.message : error);
}
