import { useEffect, useSyncExternalStore } from 'react';
import type { Command } from '../../commands/index.ts';
import { listeners } from '../../../shared/listeners.ts';

type Made = (typeof import('./sendCommands.ts'))['sendCommands'];
type Options = Parameters<Made>[0];

/**
 * Send and Send later as commands while the member writes, made by code that loads apart from the
 * first screen. It loads with the composer, which is the only place they can be used, so they're
 * there by the time anything is written to send, and at once when writing starts if not before.
 */
export function useSendCommands(isWriting: boolean, options: Options): Command[] {
  const make = useSyncExternalStore(subscribe, () => made);
  useEffect(() => {
    if (isWriting) void preloadSendCommands();
  }, [isWriting]);
  return isWriting && make ? make(options) : NONE;
}

/** Loads what makes Send and Send later. */
export function preloadSendCommands(): Promise<void> {
  loading ??= import('./sendCommands.ts').then(
    (module) => {
      made = module.sendCommands;
      tell();
    },
    () => {
      // Writing asks again next time.
      loading = undefined;
    },
  );
  return loading;
}

const NONE: Command[] = [];
let made: Made | undefined;
let loading: Promise<void> | undefined;
const { subscribe, tell } = listeners();
