import type { MessageRef } from '../../mail/core/index.ts';
import type { Notice } from './notices.ts';

/**
 * A notice as it travels: a Declarative Web Push message. Safari shows it as it is, with no
 * script, and opens `navigate` on a tap. It is mutable, so where a browser shows a notification's
 * buttons, the service worker shows it again with Archive and Mark read. Any other browser hands
 * it to the service worker, which shows it the same way.
 */
export type PushMessage = {
  web_push: 8030;
  mutable: true;
  notification: {
    title: string;
    body: string;
    tag: string;
    navigate: string;
    lang: 'en';
    data?: { message: MessageRef };
  };
};

export function pushOf({ title, body, tag, navigate, message }: Notice): PushMessage {
  return {
    web_push: 8030,
    mutable: true,
    notification: {
      title,
      body,
      tag,
      navigate,
      lang: 'en',
      ...(message ? { data: { message } } : {}),
    },
  };
}

/** The notice a push carries, read as untrusted JSON, or nothing when it carries none. */
export function noticeIn(data: unknown): Notice | undefined {
  if (!isRecord(data) || data.web_push !== 8030 || !isRecord(data.notification)) return undefined;
  const { title, body, tag, navigate, data: extra } = data.notification;
  if (typeof title !== 'string' || typeof navigate !== 'string') return undefined;
  const message = isRecord(extra) && isRef(extra.message) ? extra.message : undefined;
  return {
    title,
    body: typeof body === 'string' ? body : '',
    tag: typeof tag === 'string' ? tag : '',
    navigate,
    ...(message ? { message } : {}),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isRef(value: unknown): value is MessageRef {
  return (
    isRecord(value) &&
    typeof value.account === 'string' &&
    typeof value.path === 'string' &&
    Number.isInteger(value.uidValidity) &&
    Number.isInteger(value.uid)
  );
}
