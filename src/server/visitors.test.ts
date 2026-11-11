import { afterEach, expect, mock, setSystemTime, test } from 'bun:test';

/**
 * The demo's visitor gate, over a stand-in for its Durable Object's context: its storage, and
 * `blockConcurrencyWhile`, which runs one task at a time as workerd does. `tests/e2e/demo.e2e.ts`
 * drives the gate on workerd.
 */

await mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));
const { ceilingOf, VisitorGate } = await import('./visitors.ts');

/** A gate with its own storage, letting in `a day` visitors and `a minute` from one network. */
function gate(aDay: string, aMinute = Infinity) {
  const stored = new Map<string, unknown>();
  const counted = new Map<string, number>();
  const ctx = {
    storage: {
      get: (key: string) => Promise.resolve(stored.get(key)),
      put: (key: string, value: unknown) => Promise.resolve(void stored.set(key, value)),
    },
    blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
      const ran = blocked.then(run);
      blocked = ran.catch(() => {});
      return ran;
    },
  };
  let blocked: Promise<unknown> = Promise.resolve();
  const NEW_VISITORS = {
    // Cloudflare answers over the network, which lets other requests in meanwhile.
    limit: async ({ key }: { key: string }) => {
      counted.set(key, (counted.get(key) ?? 0) + 1);
      await Bun.sleep(1);
      return { success: counted.get(key)! <= aMinute };
    },
  };
  const env = { NEW_VISITORS_A_DAY: aDay, NEW_VISITORS };
  return { gate: new VisitorGate(ctx as never, env), stored, counted };
}

afterEach(() => setSystemTime());

test('lets in as many new visitors a day as the configuration says, and no more', async () => {
  setSystemTime(new Date('2026-11-11T08:00:00Z'));
  const { gate: visitors } = gate('2');
  expect(await visitors.admit('a', '203.0.113.1')).toBe(true);
  expect(await visitors.admit('b', '203.0.113.2')).toBe(true);
  expect(await visitors.admit('c', '203.0.113.3')).toBe(false);
  // One already in stays in, as their first requests ask at once.
  expect(await visitors.admit('a', '203.0.113.1')).toBe(true);
  expect(await visitors.admit('b', '203.0.113.9')).toBe(true);
});

test('decides one new visitor at a time, so two can’t both take the day’s last place', async () => {
  const { gate: visitors, stored } = gate('1');
  const admitted = await Promise.all([
    visitors.admit('a', '203.0.113.1'),
    visitors.admit('b', '203.0.113.2'),
    visitors.admit('c', '203.0.113.3'),
  ]);
  expect(admitted).toEqual([true, false, false]);
  expect((stored.get('today') as { visitors: string[] }).visitors).toEqual(['a']);
});

test('starts each UTC day with room again, and keeps only that day’s visitors', async () => {
  setSystemTime(new Date('2026-11-11T23:59:00Z'));
  const { gate: visitors, stored } = gate('1');
  expect(await visitors.admit('a', '203.0.113.1')).toBe(true);
  expect(await visitors.admit('b', '203.0.113.2')).toBe(false);
  setSystemTime(new Date('2026-11-12T00:00:00Z'));
  expect(await visitors.admit('b', '203.0.113.2')).toBe(true);
  expect(stored.get('today')).toEqual({ day: '2026-11-12', visitors: ['b'] });
  // Yesterday's visitors hold no place today.
  expect(await visitors.admit('a', '203.0.113.1')).toBe(false);
});

test('turns away a network past its share for the minute, without taking anyone’s place', async () => {
  const { gate: visitors, counted } = gate('3', 1);
  expect(await visitors.admit('a', '198.51.100.7')).toBe(true);
  expect(await visitors.admit('b', '198.51.100.7')).toBe(false);
  expect(await visitors.admit('c', '203.0.113.1')).toBe(true);
  expect(await visitors.admit('d', '203.0.113.2')).toBe(true);
  // A full day turns visitors away before their network's share is counted.
  expect(await visitors.admit('e', '203.0.113.3')).toBe(false);
  expect(counted.get('203.0.113.3')).toBeUndefined();
  // Nor is a visitor already in counted again.
  expect(await visitors.admit('a', '198.51.100.7')).toBe(true);
  expect(counted.get('198.51.100.7')).toBe(2);
});

test('lets nobody in when the day’s ceiling isn’t a whole number', async () => {
  expect([undefined, '', '-1', '1.5', 'ten', '100000000'].map(ceilingOf)).toEqual([
    0, 0, 0, 0, 0, 0,
  ]);
  expect(['0', '7', '100'].map(ceilingOf)).toEqual([0, 7, 100]);
  expect(await gate('').gate.admit('a', '203.0.113.1')).toBe(false);
});
