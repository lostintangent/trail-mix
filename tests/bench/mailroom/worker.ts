// The bench's Mailroom: the test Mailroom, plus a way to time its reads where they run. Local workerd
// keeps a real clock, to the millisecond, so a read is timed without the request that asks for it.
import { TestMailroom } from '../../../src/features/mailroom/server/test-worker.ts';

export { default } from '../../../src/features/mailroom/server/test-worker.ts';

export class BenchMailroom extends TestMailroom {
  /** Asks a query `times` times in a row, and says how long each answer took, in milliseconds. */
  async timed(
    name: 'conversations' | 'conversation',
    args: unknown[],
    times: number,
  ): Promise<number[]> {
    const query = (this[name] as (...args: unknown[]) => Promise<unknown>).bind(this);
    const samples: number[] = [];
    for (let i = 0; i < times; i++) {
      const started = performance.now();
      await query(...args);
      samples.push(performance.now() - started);
    }
    return samples;
  }
}
