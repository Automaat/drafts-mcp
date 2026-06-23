import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import { DraftMetadata } from './types.js';

const execFileAsync = promisify(execFile);

// Drafts stores timestamps as seconds since 2001-01-01 (Apple Cocoa reference date)
const COCOA_EPOCH_OFFSET = 978307200;

export class DraftsDatabase {
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath ||
      join(
        homedir(),
        'Library',
        'Group Containers',
        'GTFQ98J4YG.com.agiletortoise.Drafts',
        'DraftStore.sqlite'
      );
  }

  private convertCocoaTimestamp(timestamp: number): string {
    const unixTimestamp = timestamp + COCOA_EPOCH_OFFSET;
    return new Date(unixTimestamp * 1000).toISOString();
  }

  // sqlite3 -json emits an empty string (not "[]") when no rows match,
  // so guard against parsing that as JSON.
  private parseRows(stdout: string): any[] {
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : [];
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
      const { stdout } = await execFileAsync('sqlite3', [this.dbPath, '-json', query]);

      const results = this.parseRows(stdout);

      return results.map((row) => ({
        uuid: row.uuid,
        title: row.title || '',
        tags: row.tags ? row.tags.split(',').filter((t: string) => t.trim()) : [],
        createdAt: this.convertCocoaTimestamp(row.createdAt),
        modifiedAt: this.convertCocoaTimestamp(row.modifiedAt),
        isFlagged: row.isFlagged === 1,
        isArchived: row.folder === 1,
        isTrashed: row.folder === 2,
      }));
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
      WHERE ZUUID = '${uuid}'
    `;

    try {
      const { stdout } = await execFileAsync('sqlite3', [this.dbPath, '-json', query]);

      const results = this.parseRows(stdout);

      if (results.length === 0) {
        return null;
      }

      return results[0].content || '';
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
      WHERE ZCONTENT LIKE '%${searchText.replace(/'/g, "''")}%'
         OR ZTITLE LIKE '%${searchText.replace(/'/g, "''")}%'
      ORDER BY ZMODIFIED_AT DESC
    `;

    try {
      const { stdout } = await execFileAsync('sqlite3', [this.dbPath, '-json', query]);

      const results = this.parseRows(stdout);

      return results.map((row) => ({
        uuid: row.uuid,
        title: row.title || '',
        tags: row.tags ? row.tags.split(',').filter((t: string) => t.trim()) : [],
        createdAt: this.convertCocoaTimestamp(row.createdAt),
        modifiedAt: this.convertCocoaTimestamp(row.modifiedAt),
        isFlagged: row.isFlagged === 1,
        isArchived: row.folder === 1,
        isTrashed: row.folder === 2,
      }));
    } catch (error) {
      throw new Error(`Failed to search drafts: ${error}`, {
        cause: error,
      });
    }
  }
}
