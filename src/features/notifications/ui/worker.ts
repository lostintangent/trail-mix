import { afterAct, clickOf, shownOf } from '../core/shown.ts';

/**
 * The service worker's part in notifications: it shows each push, and acts on a tap or a button.
 * `src/app/service-worker.ts` hands it the worker's events.
 */

type Extendable = Event & { waitUntil(promise: Promise<unknown>): void };

export type Pushed = Extendable & {
  data: { json(): unknown } | null;
  /** The notification a declarative push proposes, where the browser shows such pushes itself. */
  notification?: unknown;
};

export type Clicked = Extendable & {
  action: string;
  notification: { data: unknown; close(): void };
};

type WindowClient = { focus(): Promise<unknown>; postMessage(message: unknown): void };

export type Worker = {
  registration: { showNotification(title: string, options: object): Promise<void> };
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: Location;
};

/** What the worker posts to an open Trail Mix for it to open a notification's address. */
export type Opening = { open: string };

/**
 * Shows a push. Where the browser shows a declarative push itself and shows no buttons, as Safari
 * does, the worker leaves it be. Every other push the worker shows, since each must show one.
 */
export function showPush(worker: Worker, event: Pushed) {
  const notifications = globalThis.Notification as { maxActions?: number } | undefined;
  const canAct = (notifications?.maxActions ?? 0) > 0;
  if (event.notification !== undefined && !canAct) return;
  let data: unknown;
  try {
    data = event.data?.json();
  } catch {
    // Not JSON, so it shows as new mail.
  }
  const { title, options } = shownOf(data, canAct);
  event.waitUntil(worker.registration.showNotification(title, options));
}

/**
 * Acts on a tap or a button. A button sends its ask to the member's Mailroom and opens nothing if
 * it went through. A tap, or a button whose ask didn't go through, opens the conversation: in the
 * open Trail Mix, which the worker brings forward, or in a new window.
 */
export function clickNotification(worker: Worker, event: Clicked) {
  event.notification.close();
  const { act, navigate } = clickOf(event.action, event.notification.data);
  event.waitUntil(
    (async () => {
      if (act && (await acted(act)) === 'done') return;
      const url = new URL(navigate, worker.location.origin).href;
      const [open] = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (!open) return worker.clients.openWindow(url);
      open.postMessage({ open: url } satisfies Opening);
      return open.focus();
    })(),
  );
}

async function acted(ask: object): Promise<'done' | 'open'> {
  try {
    const answer = await fetch('/notifications/act', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ask),
      credentials: 'same-origin',
      // Access answers a lapsed sign-in with a redirect, which mustn't be followed here.
      redirect: 'manual',
    });
    return afterAct(answer);
  } catch {
    return afterAct('unreachable');
  }
}
