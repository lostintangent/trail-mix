import { afterAll, afterEach, beforeAll, beforeEach, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
  type Page,
} from 'playwright';
import { classesOf } from '../../src/shared/build/astryxStyles.ts';
import { BUILDS, startPreview, type Build, type Preview } from './preview.ts';

/** The built app and a browser, shared by one suite's tests. */
export type Suite = {
  /** Where the app answers. Starting it again moves it, so a test reads this as it goes. */
  readonly url: string;
  /** Where the app keeps its storage, which starts empty, and again whenever the app does. */
  readonly state: string;
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
const ROOT = join(import.meta.dir, '../..');

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
  // Every class on any element of a page the test opened, and those the build's stylesheet pruned.
  const landed = new Set<string>();
  let pruned: Set<string> | undefined;
  // Whether a page opened, and whether any page reported, so a report that never comes fails.
  let isPageOpened = false;
  let isReported = false;

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
    pruned = prunedFrom(build);
  }, 60_000);

  beforeEach(async () => {
    if (!preview || (await answers(preview.url))) return;
    await preview.stop();
    preview = await startPreview(vars, env, build);
  }, 60_000);

  afterEach(async () => {
    // A round trip to each page lets the classes it last reported arrive.
    const pages = opened.flatMap((context) => context.pages());
    await Promise.all(pages.map((page) => page.evaluate(() => 0).catch(() => {})));
    // The contexts of a browser that a timed-out test took down can't be closed, and needn't be.
    await Promise.all(opened.splice(0).map((context) => context.close().catch(() => {})));
    const unstyled = [...landed].filter((name) => pruned?.has(name));
    landed.clear();
    if (unstyled.length) {
      throw new Error(
        `Elements carried ${unstyled.join(', ')}, whose rules in Astryx's stylesheet the build ` +
          'pruned. src/shared/build/astryxStyles.ts missed the Astryx code that names them.',
      );
    }
  });

  afterAll(async () => {
    await (await launched?.catch(() => undefined))?.close().catch(() => {});
    await preview?.stop();
    if (isPageOpened && !isReported) {
      throw new Error('No page reported the classes on its elements, so no test checked them.');
    }
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
    get state() {
      if (!preview) throw new Error('The app starts before the suite’s first test.');
      return preview.state;
    },
    async context(options) {
      // A browser ended with a timed-out test can still look connected for a moment.
      const browser = await launched?.catch(() => undefined);
      const context = await (browser?.isConnected() ? browser : await launch())
        .newContext(options)
        .catch(async () => (await launch()).newContext(options));
      opened.push(context);
      context.on('page', () => (isPageOpened = true));
      await context.exposeBinding(LANDED, (_, names: string[]) => {
        isReported = true;
        for (const name of names) landed.add(name);
      });
      await context.addInitScript(await reportingClasses, LANDED);
      return context;
    },
    witnessed,
    test: (name, steps, timeout) => test(name, witnessed(name, steps), timeout),
  };
}

/** The binding a page reports the classes on its elements through. */
const LANDED = '__trailMixLanded';

/**
 * What reports them, which runs in the page against the DOM's types. Its module is named at run
 * time, so the Worker's program, which reaches this file through the mail tests, never checks it.
 */
const reportingClasses = import(join(import.meta.dir, 'landed.ts')).then(
  (module: { reportClasses: (binding: string) => void }) => module.reportClasses,
);

/**
 * The classes that a rule in Astryx's whole stylesheet needs and no rule in the stylesheets of
 * `build` names, which it pruned as no Astryx code the app imports names them. A class named only
 * inside `:where()` and the like, such as StyleX's marker, prunes nothing, so it isn't one.
 */
function prunedFrom(build: Build): Set<string> {
  const { required } = classesOf(
    readFileSync(join(ROOT, 'node_modules/@astryxdesign/core/dist/astryx.css'), 'utf8'),
  );
  const assets = join(ROOT, build.directory, 'client/assets');
  const kept = new Set(
    readdirSync(assets)
      .filter((file) => file.endsWith('.css'))
      .flatMap((file) => [...classesOf(readFileSync(join(assets, file), 'utf8')).named]),
  );
  return new Set([...required].filter((name) => !kept.has(name)));
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
