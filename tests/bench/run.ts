import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchArea, Measurement } from './budget.ts';
import { workbench } from './workbench.ts';

/**
 * `bun run bench`: measures every performance budget in AGENTS.md, one area at a time, prints them,
 * writes `test-results/bench.json` for CI to attach, and fails when one is over its budget. Each
 * area is a module beside this one that exports a `BenchArea`.
 */
const AREAS: BenchArea[] = [workbench];

const results: Measurement[] = [];
for (const area of AREAS) results.push(...(await area.measure()));

const over = results.filter(({ value, budget }) => !(value <= budget));
console.table(
  results.map(({ area, name, value, budget, unit }) => ({
    area,
    budget: name,
    measured: `${value.toFixed(1)} ${unit}`,
    limit: `${budget.toFixed(1)} ${unit}`,
    '': value <= budget ? 'ok' : 'OVER',
  })),
);
const out = join(import.meta.dir, '../../test-results');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'bench.json'), JSON.stringify(results, null, 2));
if (over.length > 0) {
  console.error(`${over.length} of ${results.length} budgets exceeded.`);
  process.exit(1);
}
