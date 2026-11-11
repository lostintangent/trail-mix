import { expect, test } from 'bun:test';
import { startPreview } from './preview.ts';

/**
 * A test's preview opens no inspector. The Cloudflare plugin picks the first free inspector port
 * and only then binds it, so a preview another clone on the same machine starts at that moment
 * can take it, and the app then answers every request with EADDRINUSE. With an inspector, the
 * plugin serves a page at `/__debug` that opens DevTools on its port.
 */
test('a test preview opens no inspector for another preview to collide with', async () => {
  const preview = await startPreview();
  try {
    const debug = await (await fetch(new URL('/__debug', preview.url))).text();
    expect(debug).not.toContain('devtools.devprod.cloudflare.dev');
  } finally {
    await preview.stop();
  }
}, 60_000);
