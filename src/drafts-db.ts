import { homedir } from 'os';
import { join } from 'path';
import { DraftMetadata } from './types.js';
import { SqliteReader, SqliteDriver, ActiveDriver } from './sqlite.js';

// Drafts stores timestamps as seconds since 2001-01-01 (Apple Cocoa reference date)
const COCOA_EPOCH_OFFSET = 978307200;

export class DraftsDatabase {
  private dbPath: string;
  private reader: SqliteReader;

  constructor(dbPath?: string, options: { driver?: SqliteDriver } = {}) {
    this.dbPath =
      dbPath ||
      join(
        homedir(),
        'Library',
        'Group Containers',
        'GTFQ98J4YG.com.agiletortoise.Drafts',
        'DraftStore.sqlite'
      );
    // DRAFTS_MCP_SQLITE_DRIVER=cli forces the subprocess path as an escape hatch
    // if the in-process driver ever misbehaves on a given machine.
    const driver =
      options.driver ?? (process.env.DRAFTS_MCP_SQLITE_DRIVER === 'cli' ? 'cli' : 'auto');
    this.reader = new SqliteReader(this.dbPath, driver);
  }

  // The backend the reader resolved to ('cli' on runtimes without an in-process
  // driver). Callers use it to tune behavior, e.g. polling cadence.
  get activeDriver(): ActiveDriver {
    return this.reader.activeDriver;
  }

  // Release the persistent read-only connection. Optional for the long-lived
  // server (the OS reaps the fd on exit); used by tests to avoid leaked handles.
  dispose(): void {
    this.reader.dispose();
  }

  private convertCocoaTimestamp(timestamp: number): string {
    const unixTimestamp = timestamp + COCOA_EPOCH_OFFSET;
    return new Date(unixTimestamp * 1000).toISOString();
  }

  // Drafts stores ZCACHED_TAGS as space-separated ZZZ<tag>ZZZ tokens, not a
  // comma-separated list. The space (or end of string) is the authoritative
  // separator, so anchor the closing ZZZ to a whitespace/end boundary; keying
  // purely off ZZZ would truncate a tag ending in Z or split a tag containing
  // a literal ZZZ. Splitting on comma collapsed every tag into one string.
  private parseCachedTags(raw?: string | null): string[] {
    if (!raw) return [];
    return [...raw.matchAll(/ZZZ(.*?)ZZZ(?=\s|$)/g)].map((m) => m[1]).filter((t) => t.length > 0);
  }

  // Map one ZMANAGEDDRAFT row (CLI -json or in-process driver — same shape) to
  // DraftMetadata. Folder/flag columns come back as integers; tags/timestamps
  // are normalized via the helpers above.
  private toMetadata(row: Record<string, unknown>): DraftMetadata {
    return {
      uuid: row.uuid as string,
      title: (row.title as string) || '',
      tags: this.parseCachedTags(row.tags as string | null | undefined),
      createdAt: this.convertCocoaTimestamp(row.createdAt as number),
      modifiedAt: this.convertCocoaTimestamp(row.modifiedAt as number),
      isFlagged: row.isFlagged === 1,
      isArchived: row.folder === 1,
      isTrashed: row.folder === 2,
    };
  }

  // Escape a value for interpolation into a single-quoted SQLite string literal
  // by doubling embedded single quotes. The sqlite3 CLI takes a raw SQL string,
  // so every free-text value (uuid, search text) must be escaped to avoid
  // breaking the query or allowing SQL injection.
  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
  }

  async getAllDrafts(options?: {
    folder?: 'inbox' | 'archive' | 'trash' | 'all';
    flagged?: boolean;
  }): Promise<DraftMetadata[]> {
    let whereClause = '';
    const conditions: string[] = [];

    if (options?.folder) {
      switch (options.folder) {
        case 'inbox':
          conditions.push('ZFOLDER = 0');
          break;
        case 'archive':
          conditions.push('ZFOLDER = 1');
          break;
        case 'trash':
          conditions.push('ZFOLDER = 2');
          break;
        // 'all' means no filter
      }
    }

    if (options?.flagged !== undefined) {
      conditions.push(`ZFLAGGED = ${options.flagged ? 1 : 0}`);
    }

    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ');
    }

    // ZTITLE is usually empty; Drafts derives the display title from the first
    // line of content, so fall back to the first line (or whole content) of ZCONTENT.
    const query = `
      SELECT
        ZUUID as uuid,
        CASE
          WHEN ZTITLE IS NOT NULL AND ZTITLE != '' THEN ZTITLE
          WHEN INSTR(ZCONTENT, CHAR(10)) > 0 THEN SUBSTR(ZCONTENT, 1, INSTR(ZCONTENT, CHAR(10)) - 1)
          ELSE ZCONTENT
        END as title,
        ZCACHED_TAGS as tags,
        ZCREATED_AT as createdAt,
        ZMODIFIED_AT as modifiedAt,
        ZFLAGGED as isFlagged,
        ZFOLDER as folder
      FROM ZMANAGEDDRAFT
      ${whereClause}
      ORDER BY ZMODIFIED_AT DESC
    `;

    try {
      const results = await this.reader.query(query);

      return results.map((row) => this.toMetadata(row));
    } catch (error) {
      throw new Error(`Failed to query Drafts database: ${error}`, {
        cause: error,
      });
    }
  }

  async getDraftContent(uuid: string): Promise<string | null> {
    const query = `
      SELECT ZCONTENT as content
      FROM ZMANAGEDDRAFT
      WHERE ZUUID = '${this.escapeSqlString(uuid)}'
    `;

    try {
      const results = await this.reader.query(query);

      if (results.length === 0) {
        return null;
      }

      return (results[0].content as string) || '';
    } catch (error) {
      throw new Error(`Failed to query draft content: ${error}`, {
        cause: error,
      });
    }
  }

  async searchDrafts(searchText: string): Promise<DraftMetadata[]> {
    // Same first-line title fallback as getAllDrafts (see comment there).
    const query = `
      SELECT
        ZUUID as uuid,
        CASE
          WHEN ZTITLE IS NOT NULL AND ZTITLE != '' THEN ZTITLE
          WHEN INSTR(ZCONTENT, CHAR(10)) > 0 THEN SUBSTR(ZCONTENT, 1, INSTR(ZCONTENT, CHAR(10)) - 1)
          ELSE ZCONTENT
        END as title,
        ZCACHED_TAGS as tags,
        ZCREATED_AT as createdAt,
        ZMODIFIED_AT as modifiedAt,
        ZFLAGGED as isFlagged,
        ZFOLDER as folder
      FROM ZMANAGEDDRAFT
      WHERE ZCONTENT LIKE '%${this.escapeSqlString(searchText)}%'
         OR ZTITLE LIKE '%${this.escapeSqlString(searchText)}%'
      ORDER BY ZMODIFIED_AT DESC
    `;

    try {
      const results = await this.reader.query(query);

      return results.map((row) => this.toMetadata(row));
    } catch (error) {
      throw new Error(`Failed to search drafts: ${error}`, {
        cause: error,
      });
    }
  }

  // Core Data assigns every row a monotonically increasing integer primary key
  // (Z_PK). Capturing the max before a create lets us identify the row Drafts
  // inserts afterwards, without a browser-routed x-callback. Returns 0 when the
  // table is empty (MAX over no rows is NULL).
  async getMaxPk(): Promise<number> {
    const query = `SELECT MAX(Z_PK) as maxPk FROM ZMANAGEDDRAFT`;

    try {
      const results = await this.reader.query(query);
      return (results[0]?.maxPk as number) ?? 0;
    } catch (error) {
      throw new Error(`Failed to read max draft id: ${error}`, {
        cause: error,
      });
    }
  }

  // Find the draft Drafts created after the `afterPk` watermark. Prefer a row
  // whose content matches exactly, but fall back to the newest row past the
  // watermark so we still return a uuid when Drafts normalizes the stored
  // content (e.g. a trailing newline) or a create `action` mutates it. Callers
  // serialize creates, so within one client the only new row is the one just
  // created. `afterPk` is a number we produced; `content` is escaped.
  async findCreatedDraftUuid(afterPk: number, content: string): Promise<string | null> {
    const query = `
      SELECT ZUUID as uuid
      FROM ZMANAGEDDRAFT
      WHERE Z_PK > ${Math.floor(afterPk)}
      ORDER BY (ZCONTENT = '${this.escapeSqlString(content)}') DESC, Z_PK DESC
      LIMIT 1
    `;

    try {
      const results = await this.reader.query(query);
      return results.length > 0 ? (results[0].uuid as string) : null;
    } catch (error) {
      throw new Error(`Failed to look up created draft: ${error}`, {
        cause: error,
      });
    }
  }
}
