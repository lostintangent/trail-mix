import { useCallback, useEffect, useState } from 'react';
import { deviceStorage } from '../../../shared/deviceStorage.ts';
import type { FolderRef } from '../../mail/core/index.ts';

/**
 * Which accounts and folders this device keeps folded in the sidebar. Everything starts unfolded,
 * and the sidebar reads what's folded as it first renders, so nothing unfolds and folds again.
 */

/** What can fold: an account, or a folder with folders inside it. */
export type Foldable = { account: string } | FolderRef;

export const FOLDS_KEY = 'trail-mix.folded';

/** One key per thing that folds, so an account and a folder can never share one. */
export const foldKey = (what: Foldable): string =>
  JSON.stringify('path' in what ? [what.account, what.path] : [what.account]);

/** The keys saved as folded, or none when nothing valid is saved or storage is blocked. */
export function readFolds(storage: Pick<Storage, 'getItem'>): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(storage.getItem(FOLDS_KEY) ?? '[]');
    if (Array.isArray(saved)) {
      return new Set(saved.filter((key): key is string => typeof key === 'string'));
    }
  } catch {
    // Blocked or malformed storage leaves everything unfolded.
  }
  return new Set();
}

/** The folded keys with `key` folded if it wasn't, and unfolded if it was. */
export function toggleFold(folds: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(folds);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** What this device keeps folded, and how to fold or unfold one. */
export function useFolds(): [ReadonlySet<string>, (what: Foldable) => void] {
  const [folds, setFolds] = useState(() => readFolds(deviceStorage()));
  useEffect(() => {
    try {
      deviceStorage().setItem(FOLDS_KEY, JSON.stringify([...folds]));
    } catch {
      // What's folded lasts until the page reloads.
    }
  }, [folds]);
  const toggle = useCallback(
    (what: Foldable) => setFolds((current) => toggleFold(current, foldKey(what))),
    [],
  );
  return [folds, toggle];
}
