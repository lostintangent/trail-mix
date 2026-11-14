/** What the build's plugins read of each file Rolldown writes. */
export type Output =
  | {
      type: 'chunk';
      fileName: string;
      imports: readonly string[];
      modules?: Readonly<Record<string, { renderedLength: number }>>;
    }
  | { type: 'asset'; fileName: string };

type Bundle = Readonly<Record<string, Output>>;

/** The chunks loaded by the time `file` runs: itself and those it imports statically, at any depth. */
export function loadedWith(bundle: Bundle, file: string): Set<string> {
  const loaded = new Set<string>();
  const next = [file];
  for (let name = next.pop(); name !== undefined; name = next.pop()) {
    const output = bundle[name];
    if (loaded.has(name) || output?.type !== 'chunk') continue;
    loaded.add(name);
    next.push(...output.imports);
  }
  return loaded;
}

/**
 * Each module of `later`, named by how its id ends, that loads with the chunk holding `module`,
 * and the chunk it lies in. A plugin that keeps them off the first load fails the build on any.
 */
export function loadedAlongside(
  bundle: Bundle,
  module: string,
  later: readonly string[],
): { end: string; fileName: string }[] {
  const chunks = Object.values(bundle).flatMap((output) =>
    output.type === 'chunk' ? [output] : [],
  );
  const holding = (end: string) =>
    chunks.filter((chunk) =>
      Object.entries(chunk.modules ?? {}).some(
        ([id, rendered]) => id.endsWith(end) && rendered.renderedLength > 0,
      ),
    );
  const [first] = holding(module);
  if (!first) return [];
  const loaded = loadedWith(bundle, first.fileName);
  return later.flatMap((end) => {
    const chunk = holding(end).find(({ fileName }) => loaded.has(fileName));
    return chunk ? [{ end, fileName: chunk.fileName }] : [];
  });
}
