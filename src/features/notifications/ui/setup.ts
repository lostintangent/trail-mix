import { mailroom } from '../../mailroom/client/index.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { toast } from '../../../shared/toasts.tsx';
import {
  fromBase64Url,
  subscriptionOf,
  toBase64Url,
  type Subscription,
} from '../core/subscription.ts';
import type { Readiness } from './device.ts';
import { needsOf } from './needs.ts';

/**
 * Turning this device's notifications on and off, which the first screen goes without. It loads
 * once the device could turn them on, so it is in hand by the member's tap, which must ask the
 * browser's leave itself.
 */

/** Says what a device that can't subscribe yet needs first. */
export function sayWhatIsNeeded(readiness: Exclude<Readiness, 'able'>): void {
  void toast({ body: needsOf(readiness) });
}

/**
 * Turns this device's notifications on, asking the browser's leave before anything else so the
 * member's tap still counts, and tells the Mailroom, or turns them off and tells it that. Says
 * when the member turned the browser's question down for good, which leaves the device blocked.
 */
export async function turn(isOn: boolean, pushKey: string): Promise<'blocked' | undefined> {
  try {
    if (isOn) {
      const ended = await unsubscribe();
      if (ended) await mailroom.forgetDevice(ended);
    } else {
      await mailroom.notifyDevice(await subscribe(pushKey));
    }
    return undefined;
  } catch (error) {
    void toast({
      type: 'error',
      body: `Couldn’t turn notifications ${isOn ? 'off' : 'on'}. ${reasonOf(error)}`,
    });
    return error instanceof NotAllowed && error.answer === 'denied' ? 'blocked' : undefined;
  }
}

/** Why a device couldn't subscribe: the member turned the browser's question down, or closed it. */
class NotAllowed extends Error {
  constructor(readonly answer: 'denied' | 'default') {
    super(
      answer === 'denied'
        ? 'Notifications are blocked for Trail Mix in this browser’s settings.'
        : 'Notifications weren’t allowed.',
    );
  }
}

/**
 * Subscribes this device with the deployment's key, asking the member's leave first, as it must from
 * the tap that turns notifications on. A subscription made for another key is replaced.
 */
async function subscribe(pushKey: string): Promise<Subscription> {
  const answer = await Notification.requestPermission();
  if (answer !== 'granted') throw new NotAllowed(answer);
  const { pushManager } = await navigator.serviceWorker.ready;
  const held = await pushManager.getSubscription();
  const heldKey = held?.options.applicationServerKey;
  if (held && (!heldKey || toBase64Url(new Uint8Array(heldKey)) !== pushKey)) {
    await held.unsubscribe();
  }
  const subscription = await pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(pushKey),
  });
  return subscriptionOf(subscription.toJSON());
}

/** Ends this device's subscription, and says where it was. */
async function unsubscribe(): Promise<string | undefined> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  const held = await registration?.pushManager.getSubscription();
  await held?.unsubscribe();
  return held?.endpoint;
}
