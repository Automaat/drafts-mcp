import { CallbackServer } from '../callback-server.js';
import fetch from 'node-fetch';

describe('CallbackServer', () => {
  let server: CallbackServer;
  let port: number;

  beforeEach(async () => {
    server = new CallbackServer();
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should start on a free port', () => {
    expect(port).toBeGreaterThan(0);
    expect(server.getPort()).toBe(port);
  });

  it('should handle successful callbacks', async () => {
    const requestId = 'test-request-1';
    const responsePromise = server.registerRequest(requestId);

    const callbacks = server.getCallbackUrls(requestId);

    // Simulate success callback
    await fetch(`${callbacks.success}?text=hello&uuid=123`);

    const response = await responsePromise;

    expect(response.success).toBe(true);
    expect(response.data).toEqual({
      text: 'hello',
      uuid: '123',
    });
  });

  it('should handle error callbacks', async () => {
    const requestId = 'test-request-2';
    const responsePromise = server.registerRequest(requestId);

    const callbacks = server.getCallbackUrls(requestId);

    // Simulate error callback
    await fetch(`${callbacks.error}?error=Something went wrong`);

    const response = await responsePromise;

    expect(response.success).toBe(false);
    expect(response.error).toBe('Something went wrong');
  });

  it('should handle cancel callbacks', async () => {
    const requestId = 'test-request-3';
    const responsePromise = server.registerRequest(requestId);

    const callbacks = server.getCallbackUrls(requestId);

    // Simulate cancel callback
    await fetch(callbacks.cancel);

    const response = await responsePromise;

    expect(response.success).toBe(false);
    expect(response.error).toBe('User cancelled');
  });

  it('should timeout if no callback is received', async () => {
    const requestId = 'test-request-4';
    const responsePromise = server.registerRequest(requestId);

    await expect(responsePromise).rejects.toThrow(/timed out/);
  }, 35000);

  it('should return callback URLs with correct format', () => {
    const requestId = 'test-request-5';
    const callbacks = server.getCallbackUrls(requestId);

    expect(callbacks.success).toMatch(/^http:\/\/localhost:\d+\/x-success\/test-request-5$/);
    expect(callbacks.error).toMatch(/^http:\/\/localhost:\d+\/x-error\/test-request-5$/);
    expect(callbacks.cancel).toMatch(/^http:\/\/localhost:\d+\/x-cancel\/test-request-5$/);
  });

  it('should respond to health check', async () => {
    const response = await fetch(`http://localhost:${port}/health`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      status: 'ok',
      port,
    });
  });
});
