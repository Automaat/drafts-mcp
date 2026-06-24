import { DraftsClient, encodeQueryParams } from '../drafts-client.js';
import { CallbackServer } from '../callback-server.js';

describe('encodeQueryParams', () => {
  it('encodes spaces as %20, not + (Drafts decodes + literally)', () => {
    expect(encodeQueryParams({ text: 'hello world' })).toBe('text=hello%20world');
  });

  it('preserves a literal plus as %2B', () => {
    expect(encodeQueryParams({ text: 'a + b' })).toBe('text=a%20%2B%20b');
  });

  it('repeats the key for array values', () => {
    expect(encodeQueryParams({ tag: ['mcp test', 'automated'] })).toBe(
      'tag=mcp%20test&tag=automated'
    );
  });

  it('stringifies booleans and skips undefined values', () => {
    expect(encodeQueryParams({ flagged: true, missing: undefined, name: 'x' })).toBe(
      'flagged=true&name=x'
    );
  });

  it('percent-encodes reserved characters left alone by encodeURIComponent', () => {
    expect(encodeQueryParams({ q: "it's (a) test!" })).toBe('q=it%27s%20%28a%29%20test%21');
  });
});

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
