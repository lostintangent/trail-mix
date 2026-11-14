/**
 * A file's size as a member reads it, counting 1,000 bytes to a kilobyte as macOS and iOS do, so
 * a file reads the same wherever Trail Mix shows it.
 */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kilobytes = Math.round(bytes / 1000);
  if (kilobytes < 1000) return `${kilobytes} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
