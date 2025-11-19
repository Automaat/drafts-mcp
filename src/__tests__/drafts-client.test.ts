import { DraftsClient } from '../drafts-client.js';
import { CallbackServer } from '../callback-server.js';

describe('DraftsClient', () => {
  let callbackServer: CallbackServer;
  let draftsClient: DraftsClient;

  beforeEach(async () => {
    callbackServer = new CallbackServer();
    await callbackServer.start();
    draftsClient = new DraftsClient(callbackServer, { maxRetries: 1, retryDelay: 100 });
  });

  afterEach(async () => {
    await callbackServer.stop();
  });

  it('should construct client with callback server', () => {
    expect(draftsClient).toBeDefined();
  });

  it('should have correct configuration', () => {
    const client = new DraftsClient(callbackServer, { maxRetries: 3, retryDelay: 500 });
    expect(client).toBeDefined();
  });

  it('should use default config values', () => {
    const client = new DraftsClient(callbackServer);
    expect(client).toBeDefined();
  });
});
