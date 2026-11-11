import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Account } from '../features/mail/core/index.ts';
import { thisDeviceQuery } from '../features/mailroom/client/index.ts';

/**
 * Whether this device last saw its Mailroom hold accounts, so it can draw the desk before the
 * Mailroom answers. It's kept under the name `thisDevice` gives the Mailroom, which an erase or
 * another member signing in changes, so either forgets it. What it says is read once, as the page
 * starts.
 */
export function useHasMail(accounts: readonly Account[] | undefined): boolean {
  const [hadMail] = useState(() => read() !== undefined);
  const cache = useQuery(thisDeviceQuery).data?.cache;
  useEffect(() => {
    const held = read();
    const now = remembered(held, cache, accounts);
    if (now === held) return;
    if (now === undefined) forget();
    else write(now);
  }, [accounts, cache]);
  return hadMail;
}

/**
 * What the device remembers once it hears from the Mailroom: the Mailroom's name while it holds
 * accounts, and nothing once it holds none or answers to another name.
 */
export function remembered(
  held: string | undefined,
  cache: string | undefined,
  accounts: readonly Account[] | undefined,
): string | undefined {
  if (cache === undefined) return held;
  if (accounts) return accounts.length > 0 ? cache : undefined;
  return held === cache ? held : undefined;
}

const KEY = 'trail-mix.has-mail';

// A browser without storage remembers nothing, and asks first every time.
function read(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(cache: string) {
  try {
    localStorage.setItem(KEY, cache);
  } catch {
    // As above.
  }
}

function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // As above.
  }
}
