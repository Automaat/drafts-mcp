import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DraftsClient, encodeQueryParams, createPollInterval } from '../drafts-client.js';
import { DraftsDatabase } from '../drafts-db.js';

const execFileAsync = promisify(execFile);

describe('createPollInterval', () => {
  it('honors an explicit configured interval regardless of driver', () => {
    expect(createPollInterval(20, 'cli')).toBe(20);
    expect(createPollInterval(20, 'node-sqlite')).toBe(20);
    expect(createPollInterval(0, 'cli')).toBe(0);
  });

  it('polls tightly for in-process drivers', () => {
    expect(createPollInterval(undefined, 'node-sqlite')).toBe(75);
    expect(createPollInterval(undefined, 'bun-sqlite')).toBe(75);
    expect(createPollInterval(undefined, 'pending')).toBe(75);
  });

  it('relaxes to 200ms on the sqlite3 CLI fallback', () => {
    expect(createPollInterval(undefined, 'cli')).toBe(200);
  });
});

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

// Captures the drafts:// URL openUrl would dispatch, without launching anything.
class UrlCapturingClient extends DraftsClient {
  public lastUrl = '';
  protected async openUrl(url: string): Promise<void> {
    this.lastUrl = url;
  }
}

describe('DraftsClient buildUrl encoding', () => {
  let client: UrlCapturingClient;

  beforeEach(() => {
    // append/prepend never touch the DB, so a non-existent path is fine here.
    client = new UrlCapturingClient(new DraftsDatabase('/nonexistent.sqlite'));
  });

  it('encodes spaces in appendToDraft as %20 with no literal +', async () => {
    await client.appendToDraft('UUID-1', 'APPENDED line with spaces');
    expect(client.lastUrl).toContain('drafts://x-callback-url/append?');
    expect(client.lastUrl).toContain('text=APPENDED%20line%20with%20spaces');
    expect(client.lastUrl.split('?')[1]).not.toContain('+');
  });

  it('sets no http callback params, so Drafts opens no browser', async () => {
    await client.appendToDraft('UUID-1', 'text');
    expect(client.lastUrl).not.toContain('x-success');
    expect(client.lastUrl).not.toContain('x-error');
    expect(client.lastUrl).not.toContain('x-cancel');
    expect(client.lastUrl).not.toContain('localhost');
  });
});

// Simulates Drafts persisting the created draft to the local DB when openUrl is
// called, so we can assert createDraft reads the new uuid back from the DB.
class SimulatingClient extends DraftsClient {
  public lastUrl = '';
  constructor(
    db: DraftsDatabase,
    private dbPath: string,
    private newUuid: string,
    private newContent: string
  ) {
    super(db, { createLookupTimeout: 2000, createLookupInterval: 20 });
  }
  protected async openUrl(url: string): Promise<void> {
    this.lastUrl = url;
    if (url.includes('/create?')) {
      const uuid = this.newUuid.replace(/'/g, "''");
      const content = this.newContent.replace(/'/g, "''");
      await execFileAsync('sqlite3', [
        this.dbPath,
        `INSERT INTO ZMANAGEDDRAFT (ZUUID, ZCONTENT) VALUES ('${uuid}', '${content}')`,
      ]);
    }
  }
}

describe('DraftsClient.createDraft reads uuid from the DB', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DraftsDatabase;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drafts-client-test-'));
    dbPath = join(tmpDir, 'DraftStore.sqlite');
    const setup = `
      CREATE TABLE ZMANAGEDDRAFT (
        Z_PK INTEGER PRIMARY KEY,
        ZUUID TEXT,
        ZCONTENT TEXT
      );
      INSERT INTO ZMANAGEDDRAFT (ZUUID, ZCONTENT) VALUES ('existing', 'old draft');
    `;
    await execFileAsync('sqlite3', [dbPath, setup]);
    db = new DraftsDatabase(dbPath);
  });

  afterEach(() => {
    db.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the uuid of the draft created after the pre-create watermark', async () => {
    const client = new SimulatingClient(db, dbPath, 'NEW-UUID', 'fresh content');
    await expect(client.createDraft({ text: 'fresh content' })).resolves.toEqual({
      uuid: 'NEW-UUID',
    });
  });

  it('builds a create URL with encoded tags and no http callbacks', async () => {
    const client = new SimulatingClient(db, dbPath, 'NEW-UUID', 'hello world');
    await client.createDraft({ text: 'hello world', tags: ['a b', 'c'] });
    expect(client.lastUrl).toContain('drafts://x-callback-url/create?');
    expect(client.lastUrl).toContain('text=hello%20world');
    expect(client.lastUrl).toContain('tag=a%20b&tag=c');
    expect(client.lastUrl).not.toContain('x-success');
  });

  it('returns an object with a uuid key (undefined) when no draft appears', async () => {
    // Plain client whose openUrl is a no-op, so nothing is inserted.
    const client = new UrlCapturingClient(db, {
      createLookupTimeout: 50,
      createLookupInterval: 10,
    });
    const result = await client.createDraft({ text: 'never persisted' });
    expect(Object.keys(result)).toEqual(['uuid']);
    expect(result.uuid).toBeUndefined();
  });

  it('still dispatches the create and returns undefined when the watermark read fails', async () => {
    // A DB whose table is missing makes getMaxPk throw; the create must still
    // be sent (lastUrl set) and resolve to { uuid: undefined }, not reject.
    const brokenDb = new DraftsDatabase(join(tmpDir, 'no-table.sqlite'));
    await execFileAsync('sqlite3', [join(tmpDir, 'no-table.sqlite'), 'CREATE TABLE other (x);']);
    const client = new UrlCapturingClient(brokenDb, { maxRetries: 0 });
    const result = await client.createDraft({ text: 'x' });
    expect(result).toEqual({ uuid: undefined });
    expect(client.lastUrl).toContain('drafts://x-callback-url/create?');
    brokenDb.dispose();
  });

  it('still returns the uuid when Drafts normalizes the stored content', async () => {
    // Drafts persists 'fresh\n' but we created 'fresh' -> no exact match, so the
    // lookup falls back to the newest row past the watermark.
    const client = new SimulatingClient(db, dbPath, 'NORM-UUID', 'fresh\n');
    await expect(client.createDraft({ text: 'fresh' })).resolves.toEqual({ uuid: 'NORM-UUID' });
  });

  it('gives concurrent identical-content creates distinct uuids', async () => {
    let n = 0;
    class CountingClient extends DraftsClient {
      constructor() {
        super(db, { createLookupTimeout: 2000, createLookupInterval: 10 });
      }
      protected async openUrl(url: string): Promise<void> {
        if (url.includes('/create?')) {
          n += 1;
          await execFileAsync('sqlite3', [
            dbPath,
            `INSERT INTO ZMANAGEDDRAFT (ZUUID, ZCONTENT) VALUES ('uuid-${n}', 'dup')`,
          ]);
        }
      }
    }
    const client = new CountingClient();
    const [a, b] = await Promise.all([
      client.createDraft({ text: 'dup' }),
      client.createDraft({ text: 'dup' }),
    ]);
    expect(a.uuid).not.toBe(b.uuid);
    expect(new Set([a.uuid, b.uuid])).toEqual(new Set(['uuid-1', 'uuid-2']));
  });
});

describe('DraftsClient', () => {
  let draftsClient: DraftsClient;

  beforeEach(() => {
    draftsClient = new DraftsClient(new DraftsDatabase('/nonexistent.sqlite'));
  });

  it('should construct client with a database', () => {
    expect(draftsClient).toBeDefined();
  });

  it('should accept custom configuration', () => {
    const client = new DraftsClient(new DraftsDatabase('/nonexistent.sqlite'), {
      maxRetries: 3,
      retryDelay: 500,
      createLookupTimeout: 5000,
    });
    expect(client).toBeDefined();
  });
});
