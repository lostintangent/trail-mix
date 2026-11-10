import { answerFor, isShellOf } from '../features/offline/index.ts';

/**
 * The service worker, built to `/sw.js` by `src/shared/build/serviceWorker.ts`, which hands it its
 * build: a version and every file the build serves. It keeps those files and the build's shell,
 * so an installed Trail Mix opens with no network, and leaves every other request to the network.
 *
 * A new worker takes over at once. It keeps the previous build's files, so a page still running
 * that build can load what it hasn't yet, and drops anything older.
 */

declare const BUILD: { version: string; kept: string[] };

type Extendable = Event & { waitUntil(promise: Promise<unknown>): void };
type Fetching = Extendable & {
  request: Request;
  preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response>): void;
};
type Worker = {
  addEventListener(type: 'install' | 'activate', listener: (event: Extendable) => void): void;
  addEventListener(type: 'fetch', listener: (event: Fetching) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  registration: { navigationPreload?: { enable(): Promise<void> } };
  location: Location;
};

const worker = self as unknown as Worker;
// Read once, since the build inlines it wherever it is named.
const { version, kept: files } = BUILD;
const PREFIX = 'trail-mix-';
const CACHE = `${PREFIX}${version}`;
const KEPT = new Set(files);
/** Where the build's shell is kept. Every address loads the same shell. */
const SHELL = '/';

worker.addEventListener('install', (event) => {
  event.waitUntil(keepBuild().then(() => worker.skipWaiting()));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const builds = (await caches.keys()).filter((key) => key.startsWith(PREFIX) && key !== CACHE);
      // Caches list in the order they were made, so the last is the build before this one.
      await Promise.all(builds.slice(0, -1).map((key) => caches.delete(key)));
      await worker.registration.navigationPreload?.enable();
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener('fetch', (event) => {
  const answer = answerFor(event.request, worker.location.origin, KEPT);
  if (answer === 'kept') {
    event.respondWith(
      caches
        .match(event.request, { ignoreVary: true })
        .then((kept) => kept ?? fetch(event.request)),
    );
  } else if (answer === 'shell') {
    event.respondWith(loadPage(event));
  }
});

/**
 * A page from the network, whose shell is kept when it is this build's. Only when the network
 * can't be reached does the kept shell answer. A redirect, such as Access asking for a sign-in,
 * goes to the page as it came and is never kept.
 */
async function loadPage(event: Fetching): Promise<Response> {
  try {
    const response = (await event.preloadResponse) ?? (await fetch(event.request));
    event.waitUntil(keepShell(response.clone()));
    return response;
  } catch {
    return (await (await caches.open(CACHE)).match(SHELL)) ?? Response.error();
  }
}

async function keepShell(response: Response) {
  if (!response.ok || response.type !== 'basic' || response.redirected) return;
  const html = await response.text();
  if (!isShellOf(html, KEPT)) return;
  const cache = await caches.open(CACHE);
  await cache.put(SHELL, new Response(html, { headers: response.headers }));
}

/** Every file of the build, and its shell if the network gives it, before this worker takes over. */
async function keepBuild() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    files.map(async (path) => {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!response.ok) throw new Error(`Couldn't keep ${path}: ${response.status}`);
      // A host that varies by Origin would leave the kept copy unmatched by a request that sends
      // one, as a module script does. Each file is the same for this build whatever was sent.
      const headers = new Headers(response.headers);
      headers.delete('vary');
      await cache.put(path, new Response(response.body, { status: response.status, headers }));
    }),
  );
  const shell = await fetch(new Request(SHELL, { cache: 'reload', redirect: 'manual' })).catch(
    () => undefined,
  );
  if (shell) await keepShell(shell);
}
