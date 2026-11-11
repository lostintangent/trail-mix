import { mailroom } from '../../mailroom/client/index.ts';
import { toast } from '../../../shared/toasts.tsx';
import { fromBase64Url, subscriptionOf, type Subscription } from '../core/subscription.ts';
import type { Standing } from './device.ts';

/**
 * Turning this device's notifications on and off, which the first screen goes without. It loads
 * once the device could turn them on, so it is in hand by the member's tap, which must ask the
 * browser's leave itself.
 */

/** What each standing short of subscribing says when the member asks for notifications. */
const NEEDS = {
  'needs-install':
    'Notifications come to Trail Mix installed as an app. Install it from your browser, then turn them on there.',
  'needs-home-screen':
    'On iPhone, notifications come to Trail Mix on the Home Screen. Tap Share, then Add to Home Screen, and turn them on there.',
  blocked:
    'Notifications are blocked for Trail Mix in this browser’s settings. Allow them there, then turn them on here.',
} as const;

/** Says what a device that can't subscribe yet needs first. */
export function sayWhatIsNeeded(standing: Exclude<Standing, 'able'>): void {
  void toast({ body: NEEDS[standing === 'unable' ? 'needs-install' : standing] });
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
      body: `Couldn’t turn notifications ${isOn ? 'off' : 'on'}. ${error instanceof Error ? error.message : String(error)}`,
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
  const key = fromBase64Url(pushKey);
  const held = await pushManager.getSubscription();
  if (held && !isSameKey(held.options.applicationServerKey, key)) await held.unsubscribe();
  const subscription = await pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
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

function isSameKey(held: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!held) return false;
  const bytes = new Uint8Array(held);
  return bytes.length === key.length && bytes.every((byte, at) => byte === key[at]);
}
