/**
 * This device's side of notifications, as the first screen needs it: whether it can have them, and
 * where it is subscribed. Only the installed app has a service worker, so only it subscribes. An
 * iPhone shows notifications only to an app on its Home Screen. Subscribing is in `setup.ts`.
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
