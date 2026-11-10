// The contract suite against the demo provider, with the demo's own server playing the world.
import {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
} from '../../src/features/providers/demo/provider.ts';
import { describeContract } from './contract.ts';

describeContract('The demo provider', () => {
  const server = demoServer(
    'demo',
    demoMailbox('personal', 0, '2026-11-09T12:00:00.000Z'),
    () => {},
  );
  const bytes = (raw: string) => new TextEncoder().encode(raw);
  return Promise.resolve({
    provider: server.provider,
    address: DEMO_ACCOUNTS.personal.me.email,
    reset: () => server.empty(),
    deliver: async (raw, folder) => void (await server.deliver(bytes(raw), folder)),
    expunge: (folder, messageId) => server.expunge(folder, messageId),
    resetUidValidity: (folder) => server.resetUidValidity(folder),
    submit: (raw) => server.submit(bytes(raw)),
    close: () => server.provider.close(),
  });
});
