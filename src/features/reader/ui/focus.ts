/**
 * Keys after a click inside a message. Nothing in a message's frame runs, and WebKit runs no
 * listener in it at all, not even one the page added, so once a click puts the focus there the page
 * hears no key and no shortcut works. While such a frame holds the focus with nothing selected, the
 * page takes the focus back, onto the message's own box. Selected text keeps the focus, so it can be
 * copied, until a click that selects nothing lets it go.
 *
 * Nothing in the frame can say when a click ends, so the page reads the frame's selection from
 * outside, a few times a second, only while a message has the focus or has just given it back.
 */

const TICK_MS = 100;
/** How long the focus stays in a message with nothing selected before the page takes it back. */
const SETTLE_MS = 300;
/** How long after that a selection made by a drag that began slowly takes the focus back again. */
const TAIL_MS = 1_500;

/** Each frame whose document hears nothing, with the box that takes the focus from it. */
const deaf = new Map<HTMLIFrameElement, HTMLElement>();
let watching: ReturnType<typeof setInterval> | undefined;

const PROBE = 'trailmix-probe';

/**
 * Whether a frame's document runs the page's listeners. One that doesn't hands its focus back.
 * The probe is a listener of the page's own, so it runs wherever the page's do.
 */
export function hearsListeners(document: Document): boolean {
  let heard = false;
  const probe = () => (heard = true);
  document.addEventListener(PROBE, probe);
  document.dispatchEvent(new Event(PROBE));
  document.removeEventListener(PROBE, probe);
  return heard;
}

/** Hands the focus back from a frame that hears nothing, until the returned function is called. */
export function returnFocusFrom(frame: HTMLIFrameElement, box: HTMLElement): () => void {
  if (deaf.size === 0) addEventListener('blur', onBlur);
  deaf.set(frame, box);
  return () => {
    deaf.delete(frame);
    if (deaf.size > 0) return;
    removeEventListener('blur', onBlur);
    stop();
  };
}

/** The window loses the focus as a click moves it into a frame. */
function onBlur() {
  const active = document.activeElement;
  if (watching === undefined && active instanceof HTMLIFrameElement && deaf.has(active)) watch();
}

function watch() {
  let collapsedFor = 0;
  let gaveBack: HTMLIFrameElement | undefined;
  let tail = 0;
  watching = setInterval(() => {
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement && deaf.has(active)) {
      gaveBack = undefined;
      if (hasSelection(active)) {
        collapsedFor = 0;
        return;
      }
      collapsedFor += TICK_MS;
      if (collapsedFor < SETTLE_MS) return;
      collapsedFor = 0;
      deaf.get(active)!.focus({ preventScroll: true });
      gaveBack = active;
      tail = TAIL_MS;
      return;
    }
    // A drag that began before the focus came back selects text after it, and copying it needs
    // the focus in its frame again.
    if (gaveBack && tail > 0 && active === deaf.get(gaveBack)) {
      tail -= TICK_MS;
      if (hasSelection(gaveBack)) gaveBack.contentWindow?.focus();
      return;
    }
    stop();
  }, TICK_MS);
}

function stop() {
  clearInterval(watching);
  watching = undefined;
}

function hasSelection(frame: HTMLIFrameElement): boolean {
  const selection = frame.contentDocument?.getSelection();
  return (
    selection !== null &&
    selection !== undefined &&
    !selection.isCollapsed &&
    selection.toString().trim() !== ''
  );
}
