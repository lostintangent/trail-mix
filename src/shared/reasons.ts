/**
 * The server's own reason for a refusal, as a sentence. The Mailroom passes it on as the error's
 * message.
 */
export function reasonOf(error: unknown): string {
  const reason = error instanceof Error ? error.message.trim() : '';
  if (!reason) return 'The mail server gave no reason.';
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}
