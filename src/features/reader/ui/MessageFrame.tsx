import { colorVars, typeScaleVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { frameDocument, type FrameLook, type SafeMail } from '../core/sanitize.ts';

/**
 * One message's HTML in its own frame, sized to fit what it shows.
 *
 * The frame runs nothing: its sandbox allows no scripts and no forms, only links that open in a new
 * tab. It shares Trail Mix's origin so that it can size itself to its content without a script
 * inside, and so that its inline images and proxied ones carry the member's sign-in. That is safe
 * only because nothing in it can ever run, which the sandbox, the content security policy in its
 * document and the sanitizer each guarantee alone.
 *
 * Its document is written once per look and never touched after.
 */
export const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export type MessageFrameProps = {
  mail: SafeMail;
  quotes: FrameLook['quotes'];
  /** Names the frame for assistive technology, as "Message from Ada Park". */
  title: string;
};

export function MessageFrame({ mail, quotes, title }: MessageFrameProps) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const look = useLook(frame);
  const document = useMemo(
    () => (look ? frameDocument(mail, { ...look, quotes }) : undefined),
    [mail, look, quotes],
  );
  const onLoad = useFitToContent(box, frame);

  return (
    <div ref={box} {...stylex.props(styles.box)}>
      <iframe
        ref={frame}
        title={title}
        sandbox={FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={document}
        onLoad={onLoad}
        {...stylex.props(styles.frame, mail.ownColors ? styles.fixedPaper : styles.paper)}
      />
    </div>
  );
}

/**
 * The frame's colors and type, resolved from the theme on the frame's own element, and resolved
 * again when the theme mode or the system's changes.
 */
function useLook(frame: RefObject<HTMLIFrameElement | null>) {
  const [look, setLook] = useState<Omit<FrameLook, 'quotes'>>();
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const read = () => {
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
  }, [frame]);
  return look;
}

function readLook(element: HTMLIFrameElement): Omit<FrameLook, 'quotes'> {
  const style = getComputedStyle(element);
  const schemes = style.colorScheme.split(/\s+/);
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = schemes.includes('dark') && (!schemes.includes('light') || prefersDark);
  return {
    colorScheme: dark ? 'dark' : 'light',
    paper: style.backgroundColor,
    ink: style.color,
    link: style.accentColor,
    font: `${style.fontSize}/${style.lineHeight} ${style.fontFamily}`,
    monospace: style.getPropertyValue('--font-family-code') || 'monospace',
  };
}

/** Wider mail is scaled down to fit, but never below this, after which it scrolls sideways. */
const MIN_SCALE = 0.5;

/**
 * Sizes the frame to the document it shows, and keeps it sized as images load or the reader's width
 * changes. Mail wider than the reader is scaled down to fit, as a phone's mail app does.
 *
 * Content sized by the frame's own height, such as `100vh`, would grow without end, so once the
 * document grows because the frame did, the frame stops growing and scrolls instead.
 */
function useFitToContent(
  box: RefObject<HTMLDivElement | null>,
  frame: RefObject<HTMLIFrameElement | null>,
) {
  const observer = useRef<ResizeObserver>(null);
  useLayoutEffect(() => () => observer.current?.disconnect(), []);

  return () => {
    const container = box.current;
    const element = frame.current;
    const root = element?.contentDocument?.documentElement;
    if (!container || !element || !root) return;
    observer.current?.disconnect();
    let followsFrame = false;
    let width = 0;

    const contentHeight = () => Math.ceil(root.getBoundingClientRect().height);
    const fit = () => {
      const available = container.clientWidth;
      element.style.width = '';
      element.style.transform = '';
      const natural = root.scrollWidth;
      const scale = natural > available + 1 ? Math.max(MIN_SCALE, available / natural) : 1;
      if (scale < 1) {
        element.style.width = `${natural}px`;
        element.style.transform = `scale(${scale})`;
      }
      if (!followsFrame) {
        const height = contentHeight();
        element.style.height = `${height}px`;
        followsFrame = contentHeight() > height;
        if (followsFrame) element.style.height = `${Math.min(height, innerHeight)}px`;
      }
      container.style.height = `${Math.ceil(element.offsetHeight * scale)}px`;
      width = available;
      element.style.visibility = 'visible';
    };

    fit();
    // Refitting in the next frame keeps the observer from seeing the sizes it just set.
    let pending = 0;
    observer.current = new ResizeObserver(() => {
      if (container.clientWidth === width && followsFrame) return;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(fit);
    });
    observer.current.observe(container);
    observer.current.observe(root);
  };
}

const styles = stylex.create({
  box: {
    position: 'relative',
    overflowX: 'auto',
    overflowY: 'hidden',
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
});
