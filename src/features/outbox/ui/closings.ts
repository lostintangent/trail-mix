import type { Outgoing } from '../../mail/core/index.ts';
import { closesAt } from '../core/standing.ts';

/**
 * When the undo windows of sends this device asked for close, on its own clock, so the toast and
 * the Outbox's row count down alike. A send asked for elsewhere trusts this device's clock.
 */
const asked = new Map<string, number>();

export function rememberClosing(id: string, closes: number) {
  asked.set(id, closes);
}

export function closesFor(outgoing: Outgoing): number {
  return asked.get(outgoing.id) ?? closesAt(outgoing);
}
