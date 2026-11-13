import type {
  AccountId,
  BundleChip,
  BundleId,
  BundleSummary,
  ConversationSummary,
  GitHubReason,
  GitHubThread,
  ListItem,
} from './model.ts';

/**
 * Bundles: an account's GitHub threads in one repository, which its Inbox views list as one row,
 * named by the account and repository. A thread is what `github.ts` reads from its mail. A
 * repository and its threads open on github.com at addresses built from their names and numbers.
 */

/** Reasons that ask something of the member, which a thread's row ranks first while it's unread. */
const ASKING: ReadonlySet<GitHubReason> = new Set([
  'review_requested',
  'mention',
  'team_mention',
  'assign',
  'security_alert',
]);

/** How many chips a bundle's row carries. A row has room for fewer, and folds the rest into +N. */
export const BUNDLE_CHIPS = 12;

/** A thread's number, within a safe integer, as run ids, at eleven digits, already reach past ten. */
export const NUMBER = /^[1-9]\d{0,14}$/;
/** A commit's hash, as GitHub abbreviates it or in full. */
export const COMMIT = /^[\da-f]{7,40}$/;

/** The bundle an account's threads in one repository gather into. */
export function bundleIdOf(account: AccountId, repository: string): BundleId {
  return [account, repository.toLowerCase()].map(encodeURIComponent).join(':');
}

/** The account and repository a bundle id names, or nothing when it is not one. */
export function bundlePartsOf(
  id: BundleId,
): { account: AccountId; repository: string } | undefined {
  const parts = id.split(':');
  if (parts.length !== 2) return undefined;
  try {
    const [account, repository] = parts.map(decodeURIComponent) as [string, string];
    return account !== '' && isRepository(repository) ? { account, repository } : undefined;
  } catch {
    // A stray `%` decodes to nothing.
    return undefined;
  }
}

export const isBundle = (item: ListItem): item is BundleSummary => 'kind' in item;

/** Whether GitHub gives a reason that asks the member to act: a review, a mention or an assignment. */
export const isAsking = (reason: GitHubReason): boolean => ASKING.has(reason);

/** Whether a thread's chip asks something of the member: unread, and asked to act or a failure. */
export const asks = (chip: BundleChip): boolean =>
  chip.unread &&
  ((chip.reason !== undefined && isAsking(chip.reason)) || chip.outcome === 'failed');

/** What a bundle's row reads of each conversation it holds. */
type Bundled = Pick<
  ConversationSummary,
  'account' | 'date' | 'count' | 'unread' | 'flagged' | 'avatar'
> & { github: GitHubThread };

/**
 * A bundle's row, from its conversations newest first, each with its thread. Its chips are the
 * unread threads that ask something of the member, then the rest, at most `BUNDLE_CHIPS`.
 */
export function bundleSummaryOf(
  id: BundleId,
  conversations: readonly Bundled[],
): BundleSummary | undefined {
  const [newest] = conversations;
  if (!newest) return undefined;
  const { repository, reasons: _, ...thread } = newest.github;
  const chips = conversations.map(({ github, unread }): BundleChip => ({
    kind: github.kind,
    ...(github.state ? { state: github.state } : {}),
    ...(github.outcome ? { outcome: github.outcome } : {}),
    ...(github.reasons[0] ? { reason: github.reasons[0] } : {}),
    unread: unread > 0,
  }));
  const asking = chips.filter(asks);
  return {
    kind: 'bundle',
    id,
    account: newest.account,
    repository,
    date: newest.date,
    newest: thread,
    threads: conversations.length,
    count: conversations.reduce((sum, { count }) => sum + count, 0),
    unread: conversations.reduce((sum, { unread }) => sum + unread, 0),
    flagged: conversations.some(({ flagged }) => flagged),
    chips: [...asking, ...chips.filter((chip) => !asks(chip))].slice(0, BUNDLE_CHIPS),
    ...(newest.avatar ? { avatar: newest.avatar } : {}),
  };
}

// Links

/** A repository's address on github.com. */
export function repositoryAddressOf(repository: string): string | undefined {
  return isRepository(repository) ? `https://github.com/${repository}` : undefined;
}

/**
 * Whether `owner/repo` meets GitHub's rules for a user's or organization's name and a repository's,
 * whose characters are all safe in a URL's path as they are.
 */
export function isRepository(repository: string): boolean {
  const [owner = '', repo = '', ...rest] = repository.split('/');
  return (
    rest.length === 0 &&
    /^[a-z\d][a-z\d-]{0,38}$/i.test(owner) &&
    /^[\w.-]{1,100}$/.test(repo) &&
    repo !== '.' &&
    repo !== '..'
  );
}

/**
 * A thread's address on github.com, built from its repository and number alone, never from a link
 * in its mail. A run its mail names only by check suite opens at its commit, or else the
 * repository's runs.
 */
export function threadAddressOf(
  thread: Pick<GitHubThread, 'repository' | 'kind' | 'number' | 'commit'>,
): string | undefined {
  const repository = repositoryAddressOf(thread.repository);
  if (!repository) return undefined;
  const number =
    thread.number !== undefined && NUMBER.test(String(thread.number)) ? thread.number : undefined;
  switch (thread.kind) {
    case 'pull':
      return number === undefined ? undefined : `${repository}/pull/${number}`;
    case 'issue':
      return number === undefined ? undefined : `${repository}/issues/${number}`;
    case 'discussion':
      return number === undefined ? undefined : `${repository}/discussions/${number}`;
    case 'run':
      if (number !== undefined) return `${repository}/actions/runs/${number}`;
      if (thread.commit !== undefined && COMMIT.test(thread.commit)) {
        return `${repository}/commit/${thread.commit}`;
      }
      return `${repository}/actions`;
  }
}
