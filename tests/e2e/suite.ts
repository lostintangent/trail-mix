import { afterAll, afterEach, beforeAll, beforeEach, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
  type Page,
} from 'playwright';
import { BUILDS, startPreview, type Build, type Preview } from './preview.ts';

/** The built app and a browser, shared by one suite's tests. */
export type Suite = {
  /** Where the app answers. Starting it again moves it, so a test reads this as it goes. */
  readonly url: string;
  /** A new context, as a fresh browser profile is, which closes after the test. */
  context: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  /**
   * A test whose failure leaves evidence in `test-results/`, which CI keeps: a screenshot of each
   * page still open, what a screen reader hears on it, and the end of the app's log.
   */
  test: (name: string, steps: () => void | Promise<void>, timeout?: number) => void;
  /** Steps whose failure leaves the same evidence, for a hook that drives pages. */
  witnessed: (name: string, steps: () => void | Promise<void>) => () => Promise<void>;
};

/** Where a failed test's evidence goes, the folder CI uploads. */
const RESULTS = join(import.meta.dir, '../../test-results');

/**
 * The built app and a browser for a suite, which outlive a test that hangs. When any test times
 * out, Bun ends every process its file started, the app's and the browser's included
 * (oven-sh/bun#46373), so each later test would fail. Before each test the app starts again if it
 * stopped answering, and a context that can't be opened in the browser is opened in a new one.
 * Call it at the top of the suite, since it adds the suite's hooks.
 */
export function suite({
  vars = {},
  env = {},
  engine = chromium,
  build = BUILDS.app,
}: {
  vars?: Record<string, string>;
  /** Added to the app's environment, as `startPreview` takes it. */
  env?: Record<string, string>;
  engine?: BrowserType;
  /** Which build to serve, as `startPreview` takes it. */
  build?: Build;
} = {}): Suite {
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
    preview = await startPreview(vars, env, build);
  }, 60_000);

  beforeEach(async () => {
    if (!preview || (await answers(preview.url))) return;
    await preview.stop();
    preview = await startPreview(vars, env, build);
  }, 60_000);

  afterEach(async () => {
    // The contexts of a browser that a timed-out test took down can't be closed, and needn't be.
    await Promise.all(opened.splice(0).map((context) => context.close().catch(() => {})));
  });

  afterAll(async () => {
    await (await launched?.catch(() => undefined))?.close().catch(() => {});
    await preview?.stop();
  });

  /** Leaves what each page still open shows, and what the app logged, for a test that failed. */
  async function witness(name: string, failure: unknown) {
    mkdirSync(RESULTS, { recursive: true });
    const file = `failed-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 80)}`;
    const pages = opened.flatMap((context) => context.pages()).filter((page) => !page.isClosed());
    const shown = await Promise.all(
      pages.map(async (page, at) => {
        const shot = `${file}-${at + 1}.png`;
        const taken = await page
          .screenshot({ path: join(RESULTS, shot), fullPage: true, timeout: 10_000 })
          .then(() => shot)
          .catch((error: unknown) => `no screenshot: ${String(error)}`);
        return [`Page ${at + 1}: ${page.url()} (${taken})`, await heard(page)].join('\n');
      }),
    );
    writeFileSync(
      join(RESULTS, `${file}.txt`),
      [
        name,
        failure instanceof Error ? (failure.stack ?? failure.message) : String(failure),
        ...shown,
        `The app's log:\n${preview?.log() ?? '(not running)'}`,
      ].join('\n\n'),
    );
  }

  function witnessed(name: string, steps: () => void | Promise<void>) {
    return async () => {
      try {
        await steps();
      } catch (failure) {
        // Evidence that can't be left is said so, and the test still fails for its own reason.
        await witness(name, failure).catch((error: unknown) => {
          console.error(`No evidence of “${name}”:`, error);
        });
        throw failure;
      }
    };
  }

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
    witnessed,
    test: (name, steps, timeout) => test(name, witnessed(name, steps), timeout),
  };
}

/** What a screen reader hears on `page`, and which parts of it are still busy. */
async function heard(page: Page): Promise<string> {
  const snapshot = await page
    .ariaSnapshot({ timeout: 10_000 })
    .catch((error: unknown) => `no snapshot: ${String(error)}`);
  const busy = await page
    .locator('[aria-busy="true"]')
    .evaluateAll((all) =>
      all.map((element) => element.getAttribute('aria-label') ?? element.tagName),
    )
    .catch(() => []);
  return [snapshot, `Busy: ${busy.length > 0 ? busy.join(', ') : 'nothing'}`].join('\n');
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
