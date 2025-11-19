import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { CallbackServer } from './callback-server.js';
import { Draft } from './types.js';

const execFileAsync = promisify(execFile);

export interface DraftsClientConfig {
  maxRetries?: number;
  retryDelay?: number;
}

export class DraftsClient {
  private callbackServer: CallbackServer;
  private maxRetries: number;
  private retryDelay: number;

  constructor(callbackServer: CallbackServer, config: DraftsClientConfig = {}) {
    this.callbackServer = callbackServer;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    retries: number = this.maxRetries
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
        return this.executeWithRetry(fn, retries - 1);
      }
      throw error;
    }
  }

  private encodeURIComponentSafe(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  private buildUrl(
    endpoint: string,
    params: Record<string, string | string[] | boolean | undefined>
  ): string {
    const requestId = randomUUID();
    const callbacks = this.callbackServer.getCallbackUrls(requestId);

    const urlParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        value.forEach((v) => urlParams.append(key, v));
      } else if (typeof value === 'boolean') {
        urlParams.append(key, value.toString());
      } else {
        urlParams.append(key, value);
      }
    }

    urlParams.append('x-success', callbacks.success);
    urlParams.append('x-error', callbacks.error);
    urlParams.append('x-cancel', callbacks.cancel);

    return {
      url: `drafts://x-callback-url/${endpoint}?${urlParams.toString()}`,
      requestId,
    } as any;
  }

  private async openUrl(url: string, requestId: string): Promise<Record<string, string>> {
    const responsePromise = this.callbackServer.registerRequest(requestId);

    await execFileAsync('open', [url]);

    const response = await responsePromise;

    if (!response.success) {
      throw new Error(response.error || 'Unknown error from Drafts');
    }

    return response.data || {};
  }

  async createDraft(params: {
    text: string;
    tags?: string[];
    action?: string;
    folder?: 'inbox' | 'archive';
  }): Promise<void> {
    return this.executeWithRetry(async () => {
      const { url, requestId } = this.buildUrl('create', {
        text: params.text,
        tag: params.tags,
        action: params.action,
        folder: params.folder,
      }) as any;

      await this.openUrl(url, requestId);
    });
  }

  async getDraft(uuid: string): Promise<Draft> {
    return this.executeWithRetry(async () => {
      const { url, requestId } = this.buildUrl('get', {
        uuid,
      }) as any;

      const response = await this.openUrl(url, requestId);

      if (!response.text) {
        throw new Error('No content returned from Drafts');
      }

      // Parse the response - Drafts returns various fields
      const content = response.text || '';
      const title = response.title || content.split('\n')[0] || '';
      const tags = response.tags ? response.tags.split(',') : [];

      return {
        uuid,
        title,
        content,
        tags,
        createdAt: response.createdAt || '',
        modifiedAt: response.modifiedAt || '',
        isFlagged: response.flagged === 'true',
        isArchived: response.archived === 'true',
        isTrashed: response.trashed === 'true',
      };
    });
  }

  async appendToDraft(uuid: string, text: string): Promise<void> {
    return this.executeWithRetry(async () => {
      const { url, requestId } = this.buildUrl('append', {
        uuid,
        text,
      }) as any;

      await this.openUrl(url, requestId);
    });
  }

  async prependToDraft(uuid: string, text: string): Promise<void> {
    return this.executeWithRetry(async () => {
      const { url, requestId } = this.buildUrl('prepend', {
        uuid,
        text,
      }) as any;

      await this.openUrl(url, requestId);
    });
  }

  async openDraft(params: { uuid?: string; title?: string }): Promise<void> {
    return this.executeWithRetry(async () => {
      if (!params.uuid && !params.title) {
        throw new Error('Either uuid or title must be provided');
      }

      const { url, requestId } = this.buildUrl('open', {
        uuid: params.uuid,
        title: params.title,
      }) as any;

      await this.openUrl(url, requestId);
    });
  }

  async runAction(actionName: string, text: string): Promise<void> {
    return this.executeWithRetry(async () => {
      const { url, requestId } = this.buildUrl('runAction', {
        action: actionName,
        text,
      }) as any;

      await this.openUrl(url, requestId);
    });
  }

  async searchDrafts(params: {
    query?: string;
    tag?: string;
    folder?: 'inbox' | 'archive' | 'flagged' | 'trash' | 'all';
  }): Promise<void> {
    return this.executeWithRetry(async () => {
      const { url, requestId } = this.buildUrl('search', {
        query: params.query,
        tag: params.tag,
        folder: params.folder,
      }) as any;

      await this.openUrl(url, requestId);
    });
  }
}
