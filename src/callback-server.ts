import express, { Express, Request, Response } from 'express';
import getPort from 'get-port';
import { CallbackResponse, PendingRequest } from './types.js';

export class CallbackServer {
  private app: Express;
  private server: any;
  private port: number = 0;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private readonly REQUEST_TIMEOUT = 30000; // 30 seconds

  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Success callback handler
    this.app.get('/x-success/:requestId', (req: Request, res: Response) => {
      const { requestId } = req.params;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);

        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.query)) {
          if (typeof value === 'string') {
            data[key] = value;
          }
        }

        pending.resolve({ success: true, data });
      }

      res.status(200).send('OK');
    });

    // Error callback handler
    this.app.get('/x-error/:requestId', (req: Request, res: Response) => {
      const { requestId } = req.params;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);

        const error = (req.query.error as string) || 'Unknown error';
        pending.resolve({ success: false, error });
      }

      res.status(200).send('OK');
    });

    // Cancel callback handler
    this.app.get('/x-cancel/:requestId', (req: Request, res: Response) => {
      const { requestId } = req.params;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        pending.resolve({ success: false, error: 'User cancelled' });
      }

      res.status(200).send('OK');
    });

    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', port: this.port });
    });
  }

  async start(): Promise<number> {
    this.port = await getPort();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.error(`Callback server listening on port ${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    // Clear all pending requests
    for (const [_requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server shutting down'));
    }
    this.pendingRequests.clear();

    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server.close((err: Error | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
  }

  getPort(): number {
    return this.port;
  }

  getCallbackUrls(requestId: string): {
    success: string;
    error: string;
    cancel: string;
  } {
    const baseUrl = `http://localhost:${this.port}`;
    return {
      success: `${baseUrl}/x-success/${requestId}`,
      error: `${baseUrl}/x-error/${requestId}`,
      cancel: `${baseUrl}/x-cancel/${requestId}`,
    };
  }

  registerRequest(requestId: string): Promise<CallbackResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} timed out after ${this.REQUEST_TIMEOUT}ms`));
      }, this.REQUEST_TIMEOUT);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });
    });
  }
}
