import { COMMIT, isAsking, isRepository, NUMBER } from './bundles.ts';
import type { Address, Envelope, GitHubKind, GitHubReason, GitHubThread } from './model.ts';

/**
 * GitHub's notifications, read from the headers GitHub sends. A notification is verified mail from
 * notifications@github.com whose thread's first Message-ID names a repository and what in it the
 * mail is about, such as `<owner/repo/pull/12@github.com>`, and whose List-Id names the same
 * repository. The Cc GitHub adds says why it came, and the subject and preview say what happened.
 *
 * A conversation is a thread when every message in its Inbox is a notification of one thread, which
 * `bundles.ts` gathers by repository. Anything that doesn't read so, one spoofed message included,
 * leaves the conversation as it would be anyway.
 */

const SENDER = 'notifications@github.com';

const REASONS: ReadonlySet<string> = new Set<GitHubReason>([
  'assign',
  'author',
  'ci_activity',
  'comment',
  'manual',
  'mention',
  'push',
  'review_requested',
  'security_alert',
  'state_change',
  'subscribed',
  'team_mention',
  'your_activity',
]);

/** What one notification says. Notifications of one thread share their `thread`. */
type Notice = Omit<GitHubThread, 'reasons' | 'state'> & {
  thread: string;
  date: string;
  reason?: GitHubReason;
  /** What it did to its pull request or issue. */
  event?: 'merged' | 'closed' | 'reopened';
};

/** The thread a conversation is about, from the messages in its Inbox, or nothing if it isn't one. */
export function threadOf(inbox: readonly Envelope[]): GitHubThread | undefined {
  const notices: Notice[] = [];
  for (const envelope of inbox) {
    const notice = noticeOf(envelope);
    if (!notice || (notices.length > 0 && notice.thread !== notices[0]!.thread)) return undefined;
    notices.push(notice);
  }
  const newestFirst = notices.toSorted((a, b) => b.date.localeCompare(a.date));
  const newest = newestFirst[0];
  if (!newest) return undefined;

  const { kind, number, commit, title, repository } = newest;
  const event = newestFirst.find((notice) => notice.event)?.event;
  const outcome = newestFirst.find((notice) => notice.outcome)?.outcome;
  const reasons = [...new Set(newestFirst.flatMap(({ reason }) => (reason ? [reason] : [])))];
  return {
    repository,
    kind,
    ...(number !== undefined ? { number } : {}),
    ...(commit !== undefined ? { commit } : {}),
    title,
    ...(event === 'merged' || event === 'closed' ? { state: event } : {}),
    ...(outcome ? { outcome } : {}),
    reasons: reasons.toSorted((a, b) => Number(isAsking(b)) - Number(isAsking(a))),
  };
}

/** What a message says as a notification from GitHub, or nothing if it isn't a verified one. */
function noticeOf(envelope: Envelope): Notice | undefined {
  if (!envelope.verified || envelope.from.email.toLowerCase() !== SENDER) return undefined;
  const about = aboutOf(envelope.references[0] ?? envelope.messageId);
  if (!about) return undefined;
  const [owner, repo] = about.repository.split('/') as [string, string];
  if (envelope.list?.id.toLowerCase() !== `${repo}.${owner}.github.com`.toLowerCase()) {
    return undefined;
  }

  const subject = subjectOf(envelope.subject, about.repository);
  const run = about.kind === 'run' ? runOf(subject) : undefined;
  const title = run ? run.title : subject.replace(NUMBERED_SUFFIX, '');
  const reason = envelope.cc.map(reasonOf).find((name) => name !== undefined);
  const event = about.number !== undefined ? eventOf(envelope.preview, about.number) : undefined;
  const outcome = run ? run.outcome : checksOf(envelope.preview);
  return {
    ...about,
    ...(run?.commit ? { commit: run.commit } : {}),
    title: title || subject,
    date: envelope.date,
    ...(reason ? { reason } : {}),
    ...(event ? { event } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/** The reason an address of GitHub's Cc gives, as `review_requested@noreply.github.com` does. */
function reasonOf({ email }: Address): GitHubReason | undefined {
  const name = /^([a-z_]+)@noreply\.github\.com$/i.exec(email)?.[1]?.toLowerCase();
  return name !== undefined && REASONS.has(name) ? (name as GitHubReason) : undefined;
}

/**
 * Whether an address of a notification's Cc says why GitHub sent it, rather than naming someone
 * it went to, which a message's recipients leave out.
 */
export function isReasonOf(envelope: Envelope, address: Address): boolean {
  return reasonOf(address) !== undefined && noticeOf(envelope) !== undefined;
}

/**
 * The repository and thread a thread's first Message-ID names: `owner/repo/pull/12`, `/issues/12`
 * or `/discussions/12`, with anything after that, or a run's `owner/repo/check-suites/<id>/…` or
 * `owner/repo/actions/runs/<id>`.
 */
function aboutOf(
  root: string,
): Pick<Notice, 'repository' | 'kind' | 'number' | 'thread'> | undefined {
  const path = /^<([^<>@\s]+)@github\.com>$/i.exec(root)?.[1];
  if (!path) return undefined;
  const [owner = '', repo = '', ...rest] = path.split('/');
  const repository = `${owner}/${repo}`;
  if (!isRepository(repository)) return undefined;
  const named = (kind: GitHubKind, id: string | undefined, numbered = true) => {
    if (!id || (numbered && !NUMBER.test(id))) return undefined;
    const thread = `${repository.toLowerCase()}/${kind}/${id}`;
    return numbered
      ? { repository, kind, number: Number(id), thread }
      : { repository, kind, thread };
  };
  switch (rest[0]) {
    case 'pull':
      return named('pull', rest[1]);
    case 'issues':
    case 'issue':
      return named('issue', rest[1]);
    case 'discussions':
      return named('discussion', rest[1]);
    case 'check-suites':
      return named('run', rest[1] && /^[\w-]+$/.test(rest[1]) ? rest[1] : undefined, false);
    case 'actions':
      return rest[1] === 'runs' ? named('run', rest[2]) : undefined;
    default:
      return undefined;
  }
}

/** A subject without the replies and forwards before it and the repository GitHub names first. */
function subjectOf(subject: string, repository: string): string {
  const plain = subject.replace(/^(?:\s*(?:re|fwd?)\s*:\s*)+/i, '').trim();
  const prefix = `[${repository}]`;
  return plain.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ? plain.slice(prefix.length).trim()
    : plain;
}

/** What GitHub writes after a pull request's or issue's title: `(PR #12)`, `(Issue #12)` or `(#12)`. */
const NUMBERED_SUFFIX = /\s*\((?:PR |Issue |Discussion )?#\d+\)$/i;

/** A run's subject, such as `Run failed: CI - main (4f2a9c1)`, as its title, outcome and commit. */
function runOf(subject: string): Pick<Notice, 'title' | 'outcome' | 'commit'> {
  const said =
    /^(?:Run|Workflow run|All jobs (?:have|were)) (failed|cancell?ed|succeeded|passed|completed successfully)\s*:\s*/i.exec(
      subject,
    );
  const word = said?.[1]?.toLowerCase();
  const outcome =
    word === undefined
      ? undefined
      : word === 'failed'
        ? 'failed'
        : word.startsWith('cancel')
          ? 'cancelled'
          : 'passed';
  const rest = said ? subject.slice(said[0].length) : subject;
  const commit = /\s*\(([\da-f]{7,40})\)$/i.exec(rest);
  return {
    title: commit ? rest.slice(0, commit.index) : rest,
    ...(outcome ? { outcome } : {}),
    ...(commit && COMMIT.test(commit[1]!.toLowerCase())
      ? { commit: commit[1]!.toLowerCase() }
      : {}),
  };
}

/** What a pull request's or issue's event says it did, as `Merged #12 into main.` begins. */
function eventOf(preview: string, number: number): Notice['event'] {
  const said = /^(Merged|Closed|Reopened) #(\d+)\b/.exec(preview.trimStart());
  if (!said || Number(said[2]) !== number) return undefined;
  return said[1]!.toLowerCase() as Notice['event'];
}

/** How the checks on a pull request ended, as GitHub says it first. */
function checksOf(preview: string): Notice['outcome'] {
  const text = preview.trimStart();
  if (/^All checks have passed\b/i.test(text)) return 'passed';
  if (/^(?:Some checks were not successful|All checks have failed)\b/i.test(text)) return 'failed';
  return undefined;
}
