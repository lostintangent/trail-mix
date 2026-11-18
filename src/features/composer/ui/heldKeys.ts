import { useSyncExternalStore } from 'react';
import { listeners } from '../../../shared/listeners.ts';

/**
 * Keys pressed while a reply is on its way to its editor, as while the composer's code loads. A
 * reply counts as the composer from the moment it begins, so they never reach the conversation
 * behind it as commands. What they type waits for the reply's editor, which takes it as it first
 * places the cursor. Esc still goes back, which closes the reply, and a key in a field of its own,
 * as in search, is that field's, which drops what waited. A forward holds them too, and lets what
 * they typed go, since its cursor starts in To.
 */

/** What the keys held have typed, while a reply is on its way. */
let typed: string | undefined;
const holding = listeners();

/** Holds keys until the reply begun now takes them, keeping what is already held. */
export function holdKeys() {
  if (typed !== undefined) return;
  typed = '';
  window.addEventListener('keydown', hold, { capture: true });
  window.addEventListener('focusin', drop, { capture: true });
  holding.tell();
}

/** Lets keys go again, and returns what they typed while held. */
export function releaseKeys(): string {
  const was = typed ?? '';
  if (typed === undefined) return was;
  typed = undefined;
  window.removeEventListener('keydown', hold, { capture: true });
  window.removeEventListener('focusin', drop, { capture: true });
  holding.tell();
  return was;
}

/** Whether a reply is on its way, holding keys for its editor. */
export function useIsReplyOnItsWay(): boolean {
  return useSyncExternalStore(holding.subscribe, () => typed !== undefined);
}

function hold(event: KeyboardEvent) {
  if (event.key === 'Escape' || isTypingIn(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const was = typed ?? '';
  if (event.key === 'Backspace') typed = [...was].slice(0, -1).join('');
  else if ([...event.key].length === 1) typed = was + event.key;
}

/** A field that takes focus is where the member types now, so what waited for the reply goes. */
function drop(event: FocusEvent) {
  if (isTypingIn(event.target)) typed = '';
}

function isTypingIn(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  );
}
