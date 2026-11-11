import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { join } from 'node:path';
import type { BenchArea, Measurement } from './budget.ts';

/**
 * `bun run bench`: measures every performance budget in AGENTS.md, one area at a time, prints them,
 * writes `test-results/bench.json` for CI to attach, and fails when one is over its budget. Each
 * area is a module beside this one that exports a `BenchArea` under its own name.
 *
 * `bun run bench mailroom` measures only the areas named, as CI does in the job that has what an
 * area needs. A name that is no area fails the run, so a typo cannot pass by measuring nothing.
 */
const AREAS = ['workbench', 'reader', 'mailroom'];

const named = process.argv.slice(2);
const unknown = named.filter((name) => !AREAS.includes(name));
if (unknown.length > 0) {
  console.error(
    `No bench area is called ${unknown.join(', ')}. The areas are: ${AREAS.join(', ')}.`,
  );
  process.exit(1);
}

// The areas that drive a browser emulate a phone calibrated to this machine, so it is measured
// first, while nothing else the bench starts is running yet.
const BROWSER_AREAS = ['workbench', 'reader'];
const areas = named.length > 0 ? named : AREAS;
const phone = areas.some((name) => BROWSER_AREAS.includes(name))
  ? await (await import('./phone.ts')).calibrate()
  : undefined;

// Each area loads only when it runs. The workbench drives a browser and the Mailroom a Worker, so
// neither carries the other's tools, and each type-checks against its own runtime.
const results: Measurement[] = [];
for (const name of areas) {
  const area = ((await import(`./${name}.ts`)) as Record<string, BenchArea>)[name];
  if (!area) throw new Error(`tests/bench/${name}.ts exports no area called ${name}.`);
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
// Where an over budget's slowest inputs spent their time, so a miss on CI can be read, not rerun.
for (const { name, slowest } of over) {
  if (!slowest?.length) continue;
  console.log(`The slowest inputs behind "${name}":`);
  console.table(
    slowest.map(({ latency, inputDelay, processing, presentation, scripts }) => ({
      latency,
      'waited to run': inputDelay ?? '',
      handlers: processing ?? '',
      'waited for the frame': presentation ?? '',
      'longest scripts in its long frames': scripts
        .map(({ name, duration }) => `${name} ${duration} ms`)
        .join('; '),
    })),
  );
}
const out = join(import.meta.dir, '../../test-results');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'bench.json'), JSON.stringify(results, null, 2));
if (over.length > 0) {
  // CI runs on several CPU models, so a failure names the machine it was measured on.
  const [cpu] = cpus();
  const machine = `${cpu?.model.trim() ?? 'an unknown CPU'}, ${availableParallelism()} cores`;
  const slowdown = phone ? `, the phone at ${phone.rate.toFixed(2)}x slowdown` : '';
  console.error(`${over.length} of ${results.length} budgets exceeded on ${machine}${slowdown}.`);
  process.exit(1);
}
