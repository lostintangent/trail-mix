export type { Cursor, MailProvider, Moved, SyncBatch, SyncEvent, SyncWindow } from './provider.ts';
export { FIRST_SYNC_BATCH, SEARCH_LIMIT, SendFailure } from './provider.ts';
export { DEMO_PICTURES } from './demo/pictures.ts';
export {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
  type DemoKind,
  type DemoMailbox,
  type DemoServer,
} from './demo/provider.ts';
export type { ImapAccount, Network } from './imap/provider.ts';

/**
 * The IMAP and SMTP provider, loaded when a Mailroom first reaches a mail server. Its mail
 * libraries are most of the Worker's code, and an isolate that serves only pages and calls never
 * runs them.
 */
export const imap = () => import('./imap/provider.ts');
export {
  PRESETS,
  authServersFor,
  codeFrom,
  codeRequest,
  namesThisMachine,
  isFresh,
  pollRequest,
  polled,
  refreshRequest,
  refreshed,
  withStandIn,
  type Answer,
  type Client,
  type DeviceSignIn,
  type Endpoint,
  type Polled,
  type Preset,
  type PresetName,
  type Request,
  type Tokens,
} from './imap/core/index.ts';
