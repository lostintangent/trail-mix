import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../../src/app/global.css';
import { sanitizeMail, type SafeMail } from '../../../src/features/reader/core/sanitize.ts';
import { Reader, type MessageUrls } from '../../../src/features/reader/index.ts';
import { MessageFrame } from '../../../src/features/reader/ui/MessageFrame.tsx';
import { bodyKey, lunchThread, newsletter, type Fixture } from './fixtures.ts';

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
    /** Shows a fixture conversation in the reader, as its pane would. */
    showConversation: (fixture: 'lunch' | 'newsletter', html?: string) => void;
    /** The senders the reader was asked to always show images from. */
    allowed: string[];
    setTheme: (mode: 'light' | 'dark') => void;
    /** What hostile mail calls if any of its script ever runs. */
    __pwned: (id: string) => void;
    pwned: string[];
  }
}

window.pwned = [];
window.__pwned = (id) => window.pwned.push(id);
window.allowed = [];
window.setTheme = (mode) => {
  document.documentElement.dataset['theme'] = mode;
};

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

const message = (ref: Parameters<MessageUrls['source']>[0]) =>
  `/messages/${[ref.account, ref.path, ref.uidValidity, ref.uid].map((part) => encodeURIComponent(part)).join('/')}`;

const URLS: MessageUrls = {
  source: message,
  part: (ref, attachment) => `${message(ref)}/${encodeURIComponent(attachment)}`,
  image: (url) => `/images?url=${encodeURIComponent(url)}`,
};

window.showConversation = (name, html) => {
  const fixture: Fixture = name === 'lunch' ? lunchThread() : newsletter(html ?? '');
  flushSync(() =>
    root.render(
      <StrictMode>
        <section className="pane">
          <Reader
            conversation={fixture.conversation}
            account={fixture.account}
            bodyOf={(message) => fixture.bodies[bodyKey(message)]}
            urls={URLS}
            onAllowImages={(sender) => window.allowed.push(sender)}
          />
        </section>
      </StrictMode>,
    ),
  );
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
