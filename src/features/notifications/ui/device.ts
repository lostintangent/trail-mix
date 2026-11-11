import { fromBase64Url, subscriptionOf, type Subscription } from '../core/subscription.ts';

/**
 * This device's side of notifications: whether it can have them, and its push subscription. Only
 * the installed app has a service worker, so only it subscribes. An iPhone shows notifications only
 * to an app on its Home Screen.
 */

/** Where this device stands: able to subscribe, or what it needs first. */
export type Standing =
  /** Installed, so it subscribes. */
  | 'able'
  /** In a browser's tab, which needs Trail Mix installed. */
  | 'needs-install'
  /** In Safari on an iPhone or iPad, which needs Trail Mix on the Home Screen. */
  | 'needs-home-screen'
  /** Turned down in the browser's settings, where only the member can allow them again. */
  | 'blocked'
  /** A browser with no Web Push at all. */
  | 'unable';

export function standingOf(): Standing {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  const isInstalled = standalone === true || matchMedia('(display-mode: standalone)').matches;
  const isApplePhone = /iPhone|iPad/.test(navigator.userAgent) || standalone !== undefined;
  if (!isInstalled) return isApplePhone ? 'needs-home-screen' : 'needs-install';
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return 'unable';
  }
  return Notification.permission === 'denied' ? 'blocked' : 'able';
}

/** The endpoint this device is subscribed at, if it is. */
export async function subscribedAt(): Promise<string | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription())?.endpoint;
}

/** Why a device couldn't subscribe: the member turned the browser's question down, or closed it. */
export class NotAllowed extends Error {
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
export async function subscribe(pushKey: string): Promise<Subscription> {
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
export async function unsubscribe(): Promise<string | undefined> {
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
