import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchArea, Measurement } from './budget.ts';
import { mailroom } from './mailroom.ts';
import { workbench } from './workbench.ts';

/**
 * `bun run bench`: measures every performance budget in AGENTS.md, one area at a time, prints them,
 * writes `test-results/bench.json` for CI to attach, and fails when one is over its budget. Each
 * area is a module beside this one that exports a `BenchArea`.
 *
 * `bun run bench mailroom` measures only the areas named, as CI does in the job that has what an
 * area needs. A name that is no area fails the run, so a typo cannot pass by measuring nothing.
 */
const AREAS: BenchArea[] = [workbench, mailroom];

const named = process.argv.slice(2);
const unknown = named.filter((name) => !AREAS.some((area) => area.name === name));
if (unknown.length > 0) {
  const known = AREAS.map((area) => area.name).join(', ');
  console.error(`No bench area is called ${unknown.join(', ')}. The areas are: ${known}.`);
  process.exit(1);
}

const results: Measurement[] = [];
for (const area of AREAS.filter(({ name }) => named.length === 0 || named.includes(name))) {
  results.push(...(await area.measure()));
}

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
