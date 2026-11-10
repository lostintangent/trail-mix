// The contract suite against the demo provider, with the demo's own server playing the world.
import {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
} from '../../src/features/providers/demo/provider.ts';
import { describeContract } from './contract.ts';

for (const filesSent of [false, true]) {
  const host = filesSent ? ', on a host that files its own copy in Sent' : '';
  describeContract(`The demo provider${host}`, () => {
    const server = demoServer(
      'demo',
      demoMailbox('personal', 0, '2026-11-09T12:00:00.000Z'),
      () => {},
      { filesSent },
    );
    const bytes = (raw: string) => new TextEncoder().encode(raw);
    return Promise.resolve({
      filesSent,
      provider: server.provider,
      address: DEMO_ACCOUNTS.personal.me.email,
      async reset() {
        await server.empty();
        server.fileSentCopies(filesSent);
      },
      deliver: async (raw, folder) => void (await server.deliver(bytes(raw), folder)),
      expunge: (folder, messageId) => server.expunge(folder, messageId),
      resetUidValidity: (folder) => server.resetUidValidity(folder),
      submit: (raw) => server.submit(bytes(raw)),
      settle: () => server.settle(),
      stopFilingSent: () => Promise.resolve(server.fileSentCopies(false)),
      close: () => server.provider.close(),
    });
  });
}
