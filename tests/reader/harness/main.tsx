import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode, useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../../src/app/global.css';
import { sanitizeMail, type SafeMail } from '../../../src/features/reader/core/sanitize.ts';
import type { ConversationId, Message } from '../../../src/features/mail/core/index.ts';
import { accountsQuery, bodyQuery } from '../../../src/features/mailroom/client/index.ts';
import { sourceCommand } from '../../../src/features/reader/ui/commands.ts';
import { Reader } from '../../../src/features/reader/ui/Reader.tsx';
import { SourceDialog } from '../../../src/features/reader/ui/SourceDialog.tsx';
import { MessageFrame } from '../../../src/features/reader/ui/MessageFrame.tsx';
import { darkPaper } from '../../../src/features/reader/ui/safeMail.ts';
import { createQueryClient } from '../../../src/shared/query-client.ts';
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
  /** Whether the member chose light paper for the sender. */
  lightPaper?: boolean;
};

export type Result = Omit<SafeMail, 'html' | 'sources'>;

declare global {
  interface Window {
    show: (mails: Shown[]) => Result[];
    /** Shows one of the messages shown on light paper, or not, as the sheet's control does. */
    showOnLightPaper: (index: number, on: boolean) => void;
    /** Shows a fixture conversation in the reader, as its pane would. */
    showConversation: (
      fixture: 'lunch' | 'newsletter',
      html?: string,
      upcoming?: ConversationId[],
    ) => void;
    setTheme: (mode: 'light' | 'dark') => void;
    /** How many times a message was sanitized. */
    sanitized: number;
    /** What hostile mail calls if any of its script ever runs. */
    __pwned: (id: string) => void;
    pwned: string[];
    /** The keys the reader handed on from inside its messages. */
    messageKeys: string[];
    /** The keys the page itself heard, as the workbench's shortcuts do. */
    pageKeys: string[];
  }
}

window.pwned = [];
window.sanitized = 0;
window.messageKeys = [];
window.pageKeys = [];
addEventListener('keydown', (event: KeyboardEvent) => window.pageKeys.push(event.key));
const recordKey = (event: KeyboardEvent) => window.messageKeys.push(event.key);
window.__pwned = (id) => window.pwned.push(id);
window.setTheme = (mode) => {
  document.documentElement.dataset['theme'] = mode;
};

const root = createRoot(document.getElementById('root') as HTMLElement);

let showing: { mails: Shown[]; safe: SafeMail[]; at: number } = { mails: [], safe: [], at: 0 };

window.show = (mails) => {
  const safe = mails.map((mail) =>
    mail.walls === 'frame' ? unsanitized(mail.html) : sanitize(mail),
  );
  showing = { mails, safe, at: Date.now() };
  render();
  return safe.map(({ blockedImages, trackers, paper, quote, inlineParts }) => ({
    blockedImages,
    trackers,
    paper,
    quote,
    inlineParts,
  }));
};

window.showOnLightPaper = (index, on) => {
  showing.mails = showing.mails.map((mail, i) =>
    i === index ? { ...mail, lightPaper: on } : mail,
  );
  render();
};

function render() {
  const { mails, safe, at } = showing;
  flushSync(() =>
    root.render(
      <StrictMode>
        {safe.map((mail, i) => (
          <article key={`${at}-${i}`} data-mail={i}>
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
                isLightPaper={mails[i]?.lightPaper}
              />
            )}
          </article>
        ))}
      </StrictMode>,
    ),
  );
}

/**
 * Shows a fixture as the reader pane would: its snapshots seeded as if the Mailroom had answered,
 * and the account read from the accounts snapshot, so allowing a sender shows at once.
 */
window.showConversation = (name, html, upcoming) => {
  const fixture: Fixture = name === 'lunch' ? lunchThread() : newsletter(html ?? '');
  const queryClient = createQueryClient();
  queryClient.setQueryData(accountsQuery.queryKey, [fixture.account]);
  for (const message of fixture.conversation) {
    const body = fixture.bodies[bodyKey(message)];
    const { account, path, uidValidity, uid } = message;
    if (body)
      queryClient.setQueryData(bodyQuery({ account, path, uidValidity, uid }).queryKey, body);
  }
  flushSync(() =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <Pane fixture={fixture} upcoming={upcoming} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
};

function Pane({ fixture, upcoming }: { fixture: Fixture; upcoming?: ConversationId[] }) {
  const { data: accounts } = useQuery(accountsQuery);
  const account = accounts?.find(({ id }) => id === fixture.account.id) ?? fixture.account;
  // Each message's source, as the workbench offers it.
  const [source, setSource] = useState<Message>();
  const actionsFor = useCallback(
    (message: Message) => [sourceCommand(() => setSource(message))],
    [],
  );
  return (
    <section className="pane">
      <Reader
        conversation={fixture.conversation}
        account={account}
        upcoming={upcoming}
        onMessageKey={recordKey}
        actionsFor={actionsFor}
      />
      {source && <SourceDialog message={source} onClose={() => setSource(undefined)} />}
    </section>
  );
}

function sanitize({ html, images, parts = {} }: Shown): SafeMail {
  window.sanitized++;
  return sanitizeMail(
    html,
    {
      part: (contentId) =>
        parts[contentId] ? new URL(parts[contentId], location.origin).href : undefined,
      remote:
        images === 'allowed'
          ? (url) => new URL(`/images?url=${encodeURIComponent(url)}`, location.origin).href
          : undefined,
    },
    darkPaper(),
  );
}

function unsanitized(html: string): SafeMail {
  return {
    html,
    blockedImages: false,
    trackers: 0,
    paper: 'theme',
    quote: false,
    inlineParts: [],
    sources: [],
  };
}
