import { colorVars, typeScaleVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { REST_MS } from '../core/rest.ts';
import { frameDocument, type FrameLook, type SafeMail } from '../core/sanitize.ts';
import { hearsListeners, returnFocusFrom } from './focus.ts';

/**
 * One message's HTML in its own frame, sized to fit what it shows.
 *
 * The frame runs nothing: its sandbox allows no scripts and no forms, only links that open in a new
 * tab. It shares Trail Mix's origin so that it can size itself to its content without a script
 * inside, and so that its inline images and proxied ones carry the member's sign-in. That is safe
 * only because nothing in it can ever run, which the sandbox, the content security policy in its
 * document and the sanitizer each guarantee alone.
 *
 * Its document is written once per look and never touched after. It goes through the parser of
 * the frame's own first document, all at once, rather than as a `srcdoc` the frame navigates to.
 * A navigation crosses to the browser's process and back before the frame begins, and its parser
 * stops for the page's next frame partway through long mail, which then lays the half it has out
 * in full only to lay the whole out again. Written whole, it is laid out once, as it is fitted.
 * Long mail is written in two, its start at once and the rest once the member stays on it, so the
 * start shows without waiting on all of it, and mail passed by is never laid out in full.
 *
 * A document keeps every content security policy it was ever given, so a document after the first,
 * as when the sender's images are allowed or the theme changes, is written into a new frame.
 */
const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/**
 * Where keys pressed inside a message go. Once the member clicks into a message, its frame has the
 * focus, and the page around it never hears a key. Nothing in the frame runs, so the page listens
 * on the frame's document and hands each key on.
 */
export const MessageKeys = createContext<(event: KeyboardEvent) => void>(() => {});

type MessageFrameProps = {
  mail: SafeMail;
  quotes: FrameLook['quotes'];
  /** Names the frame for assistive technology, as "Message from Ada Park". */
  title: string;
  /** Shows it on light paper, as its sender designed it, whatever paper it would take. */
  isLightPaper?: boolean;
};

export function MessageFrame({ mail, quotes, title, isLightPaper = false }: MessageFrameProps) {
  const box = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const paper = isLightPaper ? 'light' : mail.paper;
  const look = useLook(frame, paper);
  const written = useMemo(
    () => (look ? frameDocument(mail, { ...look, quotes }) : undefined),
    [mail, look, quotes],
  );
  const fitToContent = useFitToContent(box, sizer, frame);
  const passKey = use(MessageKeys);
  const passing = useRef(passKey);
  useLayoutEffect(() => {
    passing.current = passKey;
  });
  const forgetFocus = useRef<() => void>(null);
  useLayoutEffect(() => () => forgetFocus.current?.(), []);
  // Which frame this is, and the one that already holds a document.
  const [frameKey, setFrameKey] = useState(0);
  const holding = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    const document = element?.contentDocument;
    if (written === undefined || !element || !document || !box.current) return;
    if (holding.current === element) {
      setFrameKey((key) => key + 1);
      return;
    }
    holding.current = element;
    document.open();
    document.write(written.start);
    if (!written.rest) document.close();
    fitToContent();
    document.addEventListener('keydown', (event) => passing.current(event));
    // Where the frame's document hears nothing, as in WebKit, the page takes the focus back instead.
    forgetFocus.current?.();
    forgetFocus.current = hearsListeners(document) ? null : returnFocusFrom(element, box.current);
    if (!written.rest) return;
    const rest = setTimeout(() => {
      document.write(written.rest);
      document.close();
      fitToContent();
    }, REST_MS);
    return () => clearTimeout(rest);
  }, [written, fitToContent, frameKey]);

  return (
    <div ref={box} tabIndex={-1} {...stylex.props(styles.box)}>
      <div ref={sizer} {...stylex.props(styles.sizer)}>
        <iframe
          key={frameKey}
          ref={frame}
          title={title}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          {...stylex.props(styles.frame, paper === 'light' ? styles.fixedPaper : styles.paper)}
        />
      </div>
    </div>
  );
}

/**
 * The frame's colors and type, resolved from the theme on the frame's own element, and resolved
 * again when the theme mode or the system's changes, or the paper it lies on.
 */
function useLook(frame: RefObject<HTMLIFrameElement | null>, paper: SafeMail['paper']) {
  const [look, setLook] = useState<Omit<FrameLook, 'quotes'>>();
  useLayoutEffect(() => {
    // The frame now, since a document after the first goes into a new one.
    const read = () => {
      const element = frame.current;
      if (!element) return;
      const next = readLook(element);
      setLook((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    read();
    const system = matchMedia('(prefers-color-scheme: dark)');
    system.addEventListener('change', read);
    const mode = new MutationObserver(read);
    mode.observe(document.documentElement, { attributes: true });
    return () => {
      system.removeEventListener('change', read);
      mode.disconnect();
    };
  }, [frame, paper]);
  return look;
}

function readLook(element: HTMLIFrameElement): Omit<FrameLook, 'quotes'> {
  const style = getComputedStyle(element);
  const schemes = style.colorScheme.split(/\s+/);
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = schemes.includes('dark') && (!schemes.includes('light') || prefersDark);
  // The light theme's ink and links, from a probe beside the frame in the light scheme.
  const probe = document.createElement('span');
  probe.className = stylex.props(styles.lightProbe).className ?? '';
  element.after(probe);
  const light = getComputedStyle(probe);
  const [lightInk, lightLink] = [light.color, light.accentColor];
  probe.remove();
  return {
    colorScheme: dark ? 'dark' : 'light',
    paper: style.backgroundColor,
    ink: style.color,
    link: style.accentColor,
    lightInk,
    lightLink,
    // The leading stays a ratio, as the theme writes it, so a message's larger type keeps its
    // proportion. A computed line height would be one length for every size.
    font: `${style.fontSize}/${style.getPropertyValue('--text-body-leading') || 'normal'} ${style.fontFamily}`,
    monospace: style.getPropertyValue('--font-family-code') || 'monospace',
  };
}

/** Wider mail is scaled down to fit, but never below this, after which it scrolls sideways. */
const MIN_SCALE = 0.5;

/**
 * Sizes the frame to the document it shows, and keeps it sized as images load or the reader's width
 * changes. Mail laid out wider than the reader is scaled down to fit, as a phone's mail app does.
 * The sizer around the frame takes the scaled size, since a transform alone leaves the layout as
 * wide as before.
 *
 * Content sized by the frame itself would grow without end: a `100vh` block grows the frame that
 * grows it, and a `100%` table with padding is always wider than its frame. So the frame follows
 * the document only where the document holds still, and otherwise stays put and scrolls.
 */
function useFitToContent(
  box: RefObject<HTMLDivElement | null>,
  sizer: RefObject<HTMLDivElement | null>,
  frame: RefObject<HTMLIFrameElement | null>,
) {
  const observer = useRef<ResizeObserver>(null);
  useLayoutEffect(() => () => observer.current?.disconnect(), []);

  return useCallback(() => {
    const container = box.current;
    const inner = sizer.current;
    const element = frame.current;
    const root = element?.contentDocument?.documentElement;
    if (!container || !inner || !element || !root) return;
    observer.current?.disconnect();
    let followsHeight = true;
    let fittedWidth = 0;

    const contentHeight = () => Math.ceil(root.getBoundingClientRect().height);
    const fit = () => {
      const available = container.clientWidth;
      element.style.width = '';
      element.style.transform = '';
      let scale = 1;
      const natural = root.scrollWidth;
      if (natural > available + 1) {
        element.style.width = `${natural}px`;
        if (root.scrollWidth <= natural + 1) scale = Math.max(MIN_SCALE, available / natural);
        else element.style.width = '';
      }
      if (scale < 1) element.style.transform = `scale(${scale})`;
      if (followsHeight) {
        const height = contentHeight();
        element.style.height = `${height}px`;
        followsHeight = contentHeight() <= height;
        if (!followsHeight) element.style.height = `${Math.min(height, innerHeight)}px`;
      }
      inner.style.width = scale < 1 ? `${Math.ceil(element.offsetWidth * scale)}px` : '';
      inner.style.height = `${Math.ceil(element.offsetHeight * scale)}px`;
      fittedWidth = available;
      element.style.visibility = 'visible';
    };

    fit();
    // Refitting in the next frame keeps the observer from seeing the sizes it just set.
    let pending = 0;
    observer.current = new ResizeObserver(() => {
      if (container.clientWidth === fittedWidth && !followsHeight) return;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(fit);
    });
    observer.current.observe(container);
    observer.current.observe(root);
  }, [box, sizer, frame]);
}

const styles = stylex.create({
  // It takes the focus back from its frame only so the page hears keys, so it draws no ring.
  box: {
    overflowX: 'auto',
    overflowY: 'hidden',
    outline: 'none',
  },
  sizer: {
    position: 'relative',
    overflow: 'hidden',
  },
  frame: {
    display: 'block',
    width: '100%',
    height: 0,
    borderWidth: 0,
    transformOrigin: '0 0',
    color: colorVars['--color-text-primary'],
    accentColor: colorVars['--color-text-accent'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
    // Hidden until it is first sized, so an unsized or unwritten frame never flashes.
    visibility: 'hidden',
  },
  paper: {
    backgroundColor: colorVars['--color-background-card'],
  },
  fixedPaper: {
    colorScheme: 'light',
    backgroundColor: tm.paperFixed,
  },
  lightProbe: {
    position: 'absolute',
    visibility: 'hidden',
    colorScheme: 'light',
    color: colorVars['--color-text-primary'],
    accentColor: colorVars['--color-text-accent'],
  },
});
