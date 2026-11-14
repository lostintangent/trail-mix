/**
 * Resolves with what `find` finds, once it finds anything, looking again every `every` ms, or fails
 * with `failure` once `ms` have passed without it.
 */
export async function until<T>(
  find: () => T | Promise<T>,
  ms = 2_000,
  { every = 25, failure = `Still not so after ${ms} ms.` } = {},
): Promise<NonNullable<T>> {
  const by = Date.now() + ms;
  for (;;) {
    const found = await find();
    if (found) return found;
    if (Date.now() > by) throw new Error(failure);
    await new Promise((done) => setTimeout(done, every));
  }
}
