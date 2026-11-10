import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../../src/app/global.css';
import { sanitizeMail, type SafeMail } from '../../../src/features/reader/core/sanitize.ts';
import { MessageFrame } from '../../../src/features/reader/ui/MessageFrame.tsx';

/**
 * A page that shows messages in the reader's real frames, for tests to drive in real browsers.
 * It is the app's origin: it serves the image proxy and the messages' parts, so the frames here
 * load exactly what they would in Trail Mix.
 */

export type Shown = {
  html: string;
  /** Whether the member allowed the sender's remote images. */
  images: 'blocked' | 'allowed';
  /** Content-ID to part path, for inline images. */
  parts?: Record<string, string>;
  /**
   * Which walls stand: `both` is the reader as it ships. `frame` skips the sanitizer, to test what
   * the frame alone stops, and `sanitizer` writes the sanitized markup into a frame with no sandbox
   * and no content security policy, to test what the sanitizer alone stops.
   */
  walls?: 'both' | 'frame' | 'sanitizer';
  quotes?: 'folded' | 'shown';
};

export type Result = Omit<SafeMail, 'html' | 'sources'>;

declare global {
  interface Window {
    show: (mails: Shown[]) => Result[];
    /** What hostile mail calls if any of its script ever runs. */
    __pwned: (id: string) => void;
    pwned: string[];
  }
}

window.pwned = [];
window.__pwned = (id) => window.pwned.push(id);

const root = createRoot(document.getElementById('root') as HTMLElement);

window.show = (mails) => {
  const safe = mails.map((mail) =>
    mail.walls === 'frame' ? unsanitized(mail.html) : sanitize(mail),
  );
  flushSync(() =>
    root.render(
      <StrictMode>
        {safe.map((mail, i) => (
          <article key={`${Date.now()}-${i}`} data-mail={i}>
            {mails[i]?.walls === 'sanitizer' ? (
              <iframe
                title={`Message ${i}`}
                srcDoc={`<!doctype html><body>${mail.html}`}
                style={{ visibility: 'visible', width: '100%', height: 600 }}
              />
            ) : (
              <MessageFrame
                mail={mail}
                quotes={mails[i]?.quotes ?? 'folded'}
                title={`Message ${i}`}
              />
            )}
          </article>
        ))}
      </StrictMode>,
    ),
  );
  return safe.map(({ blockedImages, ownColors, quote, inlineParts }) => ({
    blockedImages,
    ownColors,
    quote,
    inlineParts,
  }));
};

function sanitize({ html, images, parts = {} }: Shown): SafeMail {
  return sanitizeMail(html, {
    part: (contentId) =>
      parts[contentId] ? new URL(parts[contentId], location.origin).href : undefined,
    remote:
      images === 'allowed'
        ? (url) => new URL(`/images?url=${encodeURIComponent(url)}`, location.origin).href
        : undefined,
  });
}

function unsanitized(html: string): SafeMail {
  return {
    html,
    blockedImages: false,
    ownColors: false,
    quote: false,
    inlineParts: [],
    sources: [],
  };
}
