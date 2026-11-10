import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
} from 'playwright';
import { startPreview, type Preview } from './preview.ts';

/** The built app and a browser, shared by one suite's tests. */
export type Suite = {
  /** Where the app answers. Starting it again moves it, so a test reads this as it goes. */
  readonly url: string;
  /** A new context, as a fresh browser profile is, which closes after the test. */
  context: (options?: BrowserContextOptions) => Promise<BrowserContext>;
};

/**
 * The built app and a browser for a suite, which outlive a test that hangs. When any test times
 * out, Bun ends every process its file started, the app's and the browser's included
 * (oven-sh/bun#46373), so each later test would fail. Before each test the app starts again if it
 * stopped answering, and a context that can't be opened in the browser is opened in a new one.
 * Call it at the top of the suite, since it adds the suite's hooks.
 */
export function suite({
  vars = {},
  engine = chromium,
}: { vars?: Record<string, string>; engine?: BrowserType } = {}): Suite {
  let preview: Preview | undefined;
  let launched: Promise<Browser> | undefined;
  const opened: BrowserContext[] = [];

  const launch = () => {
    launched = engine.launch().catch((cause: unknown) => {
      const name = engine.name();
      throw new Error(
        `${name} didn't start. If Playwright hasn't installed it, run \`bunx playwright install ${name}\`.`,
        { cause },
      );
    });
    return launched;
  };

  beforeAll(async () => {
    preview = await startPreview(vars);
  }, 60_000);

  beforeEach(async () => {
    if (!preview || (await answers(preview.url))) return;
    await preview.stop();
    preview = await startPreview(vars);
  }, 60_000);

  afterEach(async () => {
    // The contexts of a browser that a timed-out test took down can't be closed, and needn't be.
    await Promise.all(opened.splice(0).map((context) => context.close().catch(() => {})));
  });

  afterAll(async () => {
    await (await launched?.catch(() => undefined))?.close().catch(() => {});
    await preview?.stop();
  });

  return {
    get url() {
      if (!preview) throw new Error('The app starts before the suite’s first test.');
      return preview.url;
    },
    async context(options) {
      // A browser ended with a timed-out test can still look connected for a moment.
      const browser = await launched?.catch(() => undefined);
      const context = await (browser?.isConnected() ? browser : await launch())
        .newContext(options)
        .catch(async () => (await launch()).newContext(options));
      opened.push(context);
      return context;
    },
  };
}

/** Whether the app at `url` answers at all. */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(new URL('/health', url), { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}
