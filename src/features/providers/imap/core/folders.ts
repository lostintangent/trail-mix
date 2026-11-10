/** A folder as a server lists it: its path, and the delimiter between the names in it, if any. */
export type Listed = { path: string; delimiter?: string | null };

/**
 * The folder at `path` among `listed`, with every folder inside it, the deepest first, so each can
 * be deleted before the folder that holds it. A child's path is longer than its parent's, so the
 * longest paths go first.
 */
export function subtree(listed: readonly Listed[], path: string, delimiter?: string | null) {
  const above = delimiter ? `${path}${delimiter}` : undefined;
  return listed
    .map((entry) => entry.path)
    .filter((held) => held === path || (above !== undefined && held.startsWith(above)))
    .toSorted((a, b) => b.length - a.length);
}
