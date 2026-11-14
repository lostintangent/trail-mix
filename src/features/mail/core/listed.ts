/**
 * Whether an address is on a list of them, which ignores case as mail does. It is a module of its
 * own so that the first screen, which asks it, carries no address parser.
 */
export function listed(address: string, list: readonly string[]): boolean {
  const wanted = address.toLowerCase();
  return list.some((listing) => listing.toLowerCase() === wanted);
}
