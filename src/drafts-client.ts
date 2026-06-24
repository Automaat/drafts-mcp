import { execFile } from 'child_process';
import { promisify } from 'util';
import { DraftsDatabase } from './drafts-db.js';

const execFileAsync = promisify(execFile);

// encodeURIComponent leaves !'()* unescaped; percent-encode them too so the
// value is safe inside an x-callback-url query string.
export function encodeURIComponentSafe(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

// Build an x-callback-url query string. Unlike URLSearchParams.toString(),
// this encodes spaces as %20 (not +); Drafts decodes a literal + as +, so
// URLSearchParams would corrupt every space in the payload.
export function encodeQueryParams(
  params: Record<string, string | string[] | boolean | undefined>
): string {
  const pairs: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;

    const values = Array.isArray(value)
      ? value
      : [typeof value === 'boolean' ? value.toString() : value];

    for (const v of values) {
      pairs.push(`${encodeURIComponentSafe(key)}=${encodeURIComponentSafe(v)}`);
    }
  }

  return pairs.join('&');
}

export interface DraftsClientConfig {
  maxRetries?: number;
  retryDelay?: number;
  // How long to wait for a created draft to surface in the local DB, and how
  // often to poll, before giving up and returning an undefined uuid.
  createLookupTimeout?: number;
  createLookupInterval?: number;
}

export class DraftsClient {
  private db: DraftsDatabase;
  private maxRetries: number;
  private retryDelay: number;
  private createLookupTimeout: number;
  private createLookupInterval: number;
  // Serializes createDraft calls so each captures a Z_PK watermark that already
  // reflects prior creates. Without this, two concurrent creates would share a
  // watermark and the DB lookup could not tell their drafts apart.
  private createChain: Promise<unknown> = Promise.resolve();

  constructor(db: DraftsDatabase, config: DraftsClientConfig = {}) {
    this.db = db;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.createLookupTimeout = config.createLookupTimeout ?? 10000;
    this.createLookupInterval = config.createLookupInterval ?? 200;
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

  private buildUrl(
    endpoint: string,
    params: Record<string, string | string[] | boolean | undefined>
  ): string {
    // No x-success/x-error/x-cancel: Drafts runs the action and opens nothing,
    // so macOS never routes an http:// callback to the default browser. Results
    // that callers need (the new draft uuid) come from the local DB instead.
    return `drafts://x-callback-url/${endpoint}?${encodeQueryParams(params)}`;
  }

  // Fire-and-forget: hand the drafts:// URL to Drafts and return. There is no
  // callback to await, so this resolves as soon as the URL is dispatched.
  protected async openUrl(url: string): Promise<void> {
    await execFileAsync('open', [url]);
  }

  // Poll the local DB until the draft Drafts just created (content matching,
  // Z_PK above the pre-create watermark) appears, or the timeout elapses.
  private async waitForCreatedDraft(
    beforePk: number,
    content: string
  ): Promise<string | undefined> {
    const deadline = Date.now() + this.createLookupTimeout;

    for (;;) {
      try {
        const uuid = await this.db.findCreatedDraftUuid(beforePk, content);
        if (uuid) return uuid;
      } catch {
        // Transient DB read error while polling. Keep trying until the deadline
        // rather than throwing — a throw here would let executeWithRetry re-fire
        // the create and produce a duplicate draft.
      }
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, this.createLookupInterval));
    }
  }

  async createDraft(params: {
    text: string;
    tags?: string[];
    action?: string;
    folder?: 'inbox' | 'archive';
  }): Promise<{ uuid?: string }> {
    const task = (): Promise<{ uuid?: string }> =>
      this.executeWithRetry(async () => {
        const beforePk = await this.db.getMaxPk();

        const url = this.buildUrl('create', {
          text: params.text,
          tag: params.tags,
          action: params.action,
          folder: params.folder,
        });

        await this.openUrl(url);

        // The created draft's uuid is read back from the local DB, not a callback.
        const uuid = await this.waitForCreatedDraft(beforePk, params.text);

        return { uuid };
      });

    // Run after the previous create settles (success or failure), and keep the
    // chain from rejecting so one failed create does not block the next.
    const result = this.createChain.then(task, task);
    this.createChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async appendToDraft(uuid: string, text: string): Promise<void> {
    return this.executeWithRetry(async () => {
      await this.openUrl(this.buildUrl('append', { uuid, text }));
    });
  }

  async prependToDraft(uuid: string, text: string): Promise<void> {
    return this.executeWithRetry(async () => {
      await this.openUrl(this.buildUrl('prepend', { uuid, text }));
    });
  }

  async openDraft(params: { uuid?: string; title?: string }): Promise<void> {
    return this.executeWithRetry(async () => {
      if (!params.uuid && !params.title) {
        throw new Error('Either uuid or title must be provided');
      }

      await this.openUrl(this.buildUrl('open', { uuid: params.uuid, title: params.title }));
    });
  }

  async runAction(actionName: string, text: string): Promise<void> {
    return this.executeWithRetry(async () => {
      await this.openUrl(this.buildUrl('runAction', { action: actionName, text }));
    });
  }

  async searchDrafts(params: {
    query?: string;
    tag?: string;
    folder?: 'inbox' | 'archive' | 'flagged' | 'trash' | 'all';
  }): Promise<void> {
    return this.executeWithRetry(async () => {
      await this.openUrl(
        this.buildUrl('search', {
          query: params.query,
          tag: params.tag,
          folder: params.folder,
        })
      );
    });
  }
}
