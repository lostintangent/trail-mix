import { fromCrossJSON, toJSON, type SerovalNode } from 'seroval';
import type { Account } from '../../src/features/mail/core/index.ts';
import { BUILDS, serverFunctionIds } from './preview.ts';

/**
 * The deploy's check of the public demo, once its /health reports the commit: a new visitor opens
 * the demo mailbox, and adding a real account is refused there. It is a visitor, so it takes one of
 * the day's places, and on a day the demo is already full it can only say so. `demo.e2e.ts` runs it
 * against the built demo. Run it as `bun tests/e2e/demo-check.ts <address>` after
 * `bun run build:demo`, whose server function ids it calls.
 */
export async function checkDemo(
  address: string,
  userAgent = 'trail-mix-demo-check',
): Promise<'opened' | 'full'> {
  const ids = serverFunctionIds(BUILDS.demo);
  const headers = {
    'User-Agent': userAgent,
    Origin: new URL(address).origin,
    'Sec-Fetch-Site': 'same-origin',
    'x-tsr-serverFn': 'true',
  };

  // Serving the page makes no Mailroom, and names the visitor.
  const page = await fetch(address, { headers });
  const cookie = /^__Host-visitor=[^;]+/.exec(page.headers.get('Set-Cookie') ?? '')?.[0];
  if (!page.ok || !cookie) {
    throw new Error(`The page answered ${page.status}, naming ${cookie ?? 'no visitor'}.`);
  }
  const visitor = { ...headers, Cookie: cookie };

  const accounts = new URL(`/_serverFn/${ids.query}`, address);
  accounts.searchParams.set(
    'payload',
    JSON.stringify(toJSON({ data: { name: 'accounts', args: [] } })),
  );
  const asked = await fetch(accounts, { headers: visitor });
  if (asked.status === 429) return 'full';
  if (!asked.ok) throw new Error(`The visitor's accounts answered ${asked.status}.`);
  const node = JSON.parse(await asked.text()) as SerovalNode;
  const { result } = fromCrossJSON<{ result: Account[] }>(node, { refs: new Map() });
  const held = result.map(({ name, provider }) => `${name} (${provider})`).join(', ');
  if (held !== 'Personal (demo), Work (demo)') {
    throw new Error(`The visitor holds ${held || 'no account'}, not the demo mailbox.`);
  }

  const call = new FormData();
  call.set(
    'call',
    JSON.stringify({
      name: 'addAccount',
      args: [
        {
          provider: 'imap',
          name: 'Real',
          address: 'someone@example.com',
          imap: { host: 'imap.example.com', port: 993, secure: true },
          smtp: { host: 'smtp.example.com', port: 465, secure: true },
          password: 'not-a-password',
        },
      ],
    }),
  );
  const added = await fetch(new URL(`/_serverFn/${ids.command}`, address), {
    method: 'POST',
    body: call,
    headers: visitor,
  });
  const said = await added.text();
  if (!said.includes('only the demo mailbox')) {
    throw new Error(`Adding a real account answered ${added.status}: ${said.slice(0, 200)}`);
  }
  return 'opened';
}

if (import.meta.main) {
  const [address] = process.argv.slice(2);
  if (!address) throw new Error('Name the demo’s address: bun tests/e2e/demo-check.ts <address>');
  const checked = await checkDemo(address, process.env.USER_AGENT);
  if (checked === 'opened') {
    console.log(`${address} opened the demo mailbox to a new visitor, and refused a real account.`);
  } else {
    // A warning on the run, since a gate that refused everyone would look the same.
    const full = `${address} is full for now, so a new visitor couldn't be checked.`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${full}` : full);
  }
}
