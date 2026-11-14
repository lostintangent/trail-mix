/** Waits until `check` holds, looking again every 25 ms, or fails once `ms` have passed without it. */
export async function until(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const by = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > by) throw new Error(`Still not so after ${ms} ms.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
