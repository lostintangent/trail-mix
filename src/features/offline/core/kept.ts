/**
 * What the installed app keeps of what it has seen, so it opens to it with no network: the
 * snapshots of accounts, folders, the Outbox, the lists it showed, the conversations it opened
 * and their bodies. Never a sign-in, never anything only an operator sees.
 */

const KEPT_KINDS: ReadonlySet<unknown> = new Set([
  'accounts',
  'folders',
  'outbox',
  'conversations',
  'conversation',
  'body',
]);

/** Whether a snapshot is kept, by its query key. Sign-ins sit under accounts, and aren't. */
export function isKept(queryKey: readonly unknown[]): boolean {
  const [kind] = queryKey;
  return KEPT_KINDS.has(kind) && !(kind === 'accounts' && queryKey.length > 1);
}

/** How long a snapshot is kept after it was last fetched: as long as an idle Mailroom checks mail. */
export const KEEP_FOR_MS = 30 * 24 * 60 * 60_000;

/** The most bodies kept, and the most bytes they may take between them. */
export const BODY_LIMITS: { count: number; bytes: number } = {
  count: 1_000,
  bytes: 150 * 1024 * 1024,
};

/** A snapshot as the query cache persists it. */
export type Persisted = {
  queryKey: readonly unknown[];
  queryHash: string;
  state: { data?: unknown; dataUpdatedAt: number };
  buster: string;
};

/** A snapshot as it is kept: a list holds its first page only, and a body knows its size. */
export type Kept = Persisted & { bytes: number };

export function keptOf(persisted: Persisted): Kept {
  const [kind] = persisted.queryKey;
  const { data } = persisted.state;
  if (kind === 'conversations' && isPaged(data)) {
    const first = { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) };
    return { ...persisted, state: { ...persisted.state, data: first }, bytes: 0 };
  }
  const bytes = kind === 'body' ? (JSON.stringify(data)?.length ?? 0) : 0;
  return { ...persisted, bytes };
}

/** What eviction needs to know of a kept snapshot. */
export type Held = { key: string; kind: unknown; at: number; bytes: number };

/**
 * The kept bodies to drop so the rest fit the limits, those fetched longest ago first. Nothing but
 * bodies grows without bound: every other snapshot is one of a few, and expires.
 */
export function evictions(held: readonly Held[], limits = BODY_LIMITS): string[] {
  const bodies = held.filter(({ kind }) => kind === 'body').sort((a, b) => b.at - a.at);
  const dropped: string[] = [];
  let bytes = 0;
  bodies.forEach((body, index) => {
    bytes += body.bytes;
    if (index >= limits.count || bytes > limits.bytes) dropped.push(body.key);
  });
  return dropped;
}

function isPaged(data: unknown): data is { pages: unknown[]; pageParams: unknown[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { pages?: unknown }).pages) &&
    Array.isArray((data as { pageParams?: unknown }).pageParams)
  );
}
