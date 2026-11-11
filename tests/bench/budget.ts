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
  inputDelay?: number;
  processing?: number;
  presentation?: number;
  scripts: { name: string; duration: number }[];
};

/** A part of Trail Mix whose budgets one module measures, under the numbers in AGENTS.md. */
export type BenchArea = { name: string; measure: () => Promise<Measurement[]> };

/** The value at fraction `p` of a set of samples, such as 0.95 for the 95th percentile. */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
}
