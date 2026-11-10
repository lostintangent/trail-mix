export type { Cursor, MailProvider, Moved, SyncBatch, SyncEvent, SyncWindow } from './provider.ts';
export { FIRST_SYNC_BATCH, SEARCH_LIMIT, SendFailure } from './provider.ts';
export {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
  type DemoKind,
  type DemoMailbox,
  type DemoServer,
} from './demo/provider.ts';
export {
  checkSignIn,
  imapProvider,
  SIGN_IN_PATIENCE_MS,
  type ImapAccount,
  type Network,
} from './imap/provider.ts';
export {
  PRESETS,
  codeFrom,
  codeRequest,
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
