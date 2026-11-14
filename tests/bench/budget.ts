/** One measured budget. Lower is better for every one, so a value over its budget fails. */
export type Measurement = {
  area: string;
  name: string;
  value: number;
  budget: number;
  unit: 'ms' | 'KB';
  /** The slowest samples behind the value, and where their time went, to read when one is over. */
  slowest?: Slow[];
};

/**
 * One slow input: its latency, split where Event Timing can split it, and the scripts that ran
 * longest in the frames it waited through, from Long Animation Frame timing.
 */
export type Slow = {
  latency: number;
  /** Which of its round's inputs it was, counting from 0, as the first of a held key's repeats is 0. */
  nth: number;
  inputDelay?: number;
  processing?: number;
  presentation?: number;
  /** The asks of the Mailroom it waited on, from its input, with the parts the Worker timed. */
  asks?: Ask[];
  scripts: { name: string; duration: number }[];
};

/** One ask of the Mailroom: its name, when it went after the input and how long it took, in ms. */
export type Ask = { name: string; after: number; took: number; server: Record<string, number> };

/** A part of Trail Mix whose budgets one module measures, under the numbers in AGENTS.md. */
export type BenchArea = { measure: () => Promise<Measurement[]> };

/** The value at fraction `p` of a set of samples, such as 0.95 for the 95th percentile. */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
}
