import type { MessageRef } from '../../mail/core/index.ts';
import type { Notice } from './notices.ts';
import { noticeIn } from './push.ts';

/**
 * A notice as the service worker shows it, and what a tap or one of its buttons does. Safari shows
 * a push itself and opens its address on a tap. Elsewhere the worker shows it, with Archive and
 * Mark read where the platform shows a notification's buttons.
 */

/** What a shown notification carries for a tap or a button: where it leads and its message. */
export type Shown = { navigate: string; message?: MessageRef };

/** A notification's buttons, for a notice about one message, where the platform shows any. */
export const BUTTONS = [
  { action: 'archive', title: 'Archive' },
  { action: 'read', title: 'Mark read' },
] as const;

export type Button = (typeof BUTTONS)[number]['action'];

/** What shows when a push carries no notice it can read, since every push must show one. */
const NEW_MAIL: Notice = { title: 'New mail', body: '', tag: 'news', navigate: '/' };

/** The title and options `showNotification` takes for a push's data, buttons and all if `canAct`. */
export function shownOf(data: unknown, canAct: boolean) {
  const { title, body, tag, navigate, message } = noticeIn(data) ?? NEW_MAIL;
  const shown: Shown = message ? { navigate, message } : { navigate };
  return {
    title,
    options: {
      body,
      tag,
      lang: 'en',
      icon: '/icons/icon-192.png',
      data: shown,
      ...(canAct && message ? { actions: BUTTONS.map((button) => ({ ...button })) } : {}),
    },
  };
}

/**
 * What a tap or a button asks: a button pressed on a notification about a message acts on it, and
 * anything else opens where the notification leads.
 */
export function clickOf(
  action: string,
  data: unknown,
): { act?: { action: Button; message: MessageRef }; navigate: string } {
  const { navigate, message } = shownIn(data);
  const button = BUTTONS.find((each) => each.action === action)?.action;
  return button && message ? { act: { action: button, message }, navigate } : { navigate };
}

/**
 * Whether a button's ask went through. A lapsed sign-in comes back as Access's redirect, which a
 * worker sees as an opaque one, and anything refused or unanswered opens the conversation instead,
 * where the member can act and sign in again if asked.
 */
export function afterAct(answer: { type: string; ok: boolean } | 'unreachable'): 'done' | 'open' {
  return answer !== 'unreachable' && answer.type !== 'opaqueredirect' && answer.ok
    ? 'done'
    : 'open';
}

function shownIn(data: unknown): Shown {
  const { navigate, message } = (data ?? {}) as Partial<Shown>;
  const read = noticeIn({
    web_push: 8030,
    notification: { title: '', navigate, data: { message } },
  });
  // Only Trail Mix's own addresses open, whatever a notification says.
  const isOwn =
    typeof read?.navigate === 'string' &&
    read.navigate.startsWith('/') &&
    !read.navigate.startsWith('//');
  return {
    navigate: isOwn ? read.navigate : '/',
    ...(read?.message ? { message: read.message } : {}),
  };
}
