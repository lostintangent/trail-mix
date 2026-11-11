/**
 * Light paper: in the dark theme, a sender's HTML mail shown on light paper, as they designed it,
 * instead of darkened. The member chooses it for a sender on an account.
 */

/** Whether the member chose light paper for a sender, by address, on an account. */
export function isLightPaper(sender: string, lightPaperFrom: readonly string[]): boolean {
  const address = sender.toLowerCase();
  return lightPaperFrom.some((email) => email.toLowerCase() === address);
}
