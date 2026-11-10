import type { Account } from '../../mail/core/index.ts';

/** How the member's mail stands across every account, in one line at the foot of the sidebar. */
export type MailStatus = { tone: 'ready' | 'busy' | 'trouble'; label: string };

/**
 * An account in trouble outranks one still syncing, so a sign-in that ran out is never hidden
 * behind a sync that will finish on its own. With no accounts there is nothing to say.
 */
export function mailStatus(accounts: readonly Account[]): MailStatus | undefined {
  const [first, ...others] = accounts.filter(
    ({ status }) => status === 'needs-sign-in' || status === 'error',
  );
  if (first && others.length > 0) {
    return { tone: 'trouble', label: `${others.length + 1} accounts need attention` };
  }
  if (first) {
    const label =
      first.status === 'needs-sign-in'
        ? `Sign in to ${first.name} again`
        : `Can’t reach ${first.name}`;
    return { tone: 'trouble', label };
  }
  if (accounts.some(({ status }) => status === 'syncing')) {
    return { tone: 'busy', label: 'Checking for mail' };
  }
  return accounts.length > 0 ? { tone: 'ready', label: 'Up to date' } : undefined;
}
