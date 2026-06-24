import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DraftsDatabase } from '../drafts-db.js';

const execFileAsync = promisify(execFile);

// These tests run the real sqlite3 CLI (as the implementation does) against a
// throwaway database that mirrors the relevant ZMANAGEDDRAFT columns.
describe('DraftsDatabase', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DraftsDatabase;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drafts-db-test-'));
    dbPath = join(tmpDir, 'DraftStore.sqlite');

    const setup = `
      CREATE TABLE ZMANAGEDDRAFT (
        ZUUID TEXT,
        ZTITLE TEXT,
        ZCONTENT TEXT,
        ZCACHED_TAGS TEXT,
        ZCREATED_AT REAL,
        ZMODIFIED_AT REAL,
        ZFLAGGED INTEGER,
        ZFOLDER INTEGER
      );
      INSERT INTO ZMANAGEDDRAFT VALUES
        ('uuid-title', 'Explicit Title', 'Body one' || CHAR(10) || 'Body two', 'ZZZworkZZZ ZZZpersonalZZZ', 0, 100, 1, 0),
        ('uuid-multiline', '', 'First line title' || CHAR(10) || 'second line', 'ZZZideasZZZ', 0, 90, 0, 0),
        ('uuid-singleline', '', 'Single line only', '', 0, 80, 0, 1),
        ('uuid-empty', '', '', NULL, 0, 70, 0, 2),
        ('uuid-nulls', NULL, NULL, NULL, 0, 60, 0, 0);
    `;
    await execFileAsync('sqlite3', [dbPath, setup]);
    db = new DraftsDatabase(dbPath);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getAllDrafts title extraction', () => {
    it('uses ZTITLE when it is present', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 'uuid-title')?.title).toBe('Explicit Title');
    });

    it('extracts the first line when ZTITLE is empty and content has newlines', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 'uuid-multiline')?.title).toBe('First line title');
    });

    it('uses the whole content when ZTITLE is empty and content has no newline', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 'uuid-singleline')?.title).toBe('Single line only');
    });

    it('returns an empty title when both ZTITLE and content are empty', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 'uuid-empty')?.title).toBe('');
    });

    it('returns an empty title when ZTITLE and content are null', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 'uuid-nulls')?.title).toBe('');
    });
  });

  describe('getAllDrafts metadata mapping', () => {
    it('orders results by modified date descending', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.map((d) => d.uuid)).toEqual([
        'uuid-title',
        'uuid-multiline',
        'uuid-singleline',
        'uuid-empty',
        'uuid-nulls',
      ]);
    });

    it('parses tags, flags and timestamps', async () => {
      const drafts = await db.getAllDrafts();
      const draft = drafts.find((d) => d.uuid === 'uuid-title')!;
      expect(draft.tags).toEqual(['work', 'personal']);
      expect(draft.isFlagged).toBe(true);
      expect(draft.isArchived).toBe(false);
      expect(draft.isTrashed).toBe(false);
      expect(draft.createdAt).toBe('2001-01-01T00:00:00.000Z');
    });

    it('maps archive and trash folders', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 'uuid-singleline')?.isArchived).toBe(true);
      expect(drafts.find((d) => d.uuid === 'uuid-empty')?.isTrashed).toBe(true);
    });

    it('returns empty tags when ZCACHED_TAGS is null', async () => {
      const drafts = await db.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 'uuid-empty')?.tags).toEqual([]);
    });

    it('parses ZZZ-wrapped tag tokens without leaking the sentinels', async () => {
      const drafts = await db.getAllDrafts();
      const tags = drafts.find((d) => d.uuid === 'uuid-title')!.tags;
      expect(tags).toEqual(['work', 'personal']);
      expect(tags.join(' ')).not.toContain('ZZZ');
    });
  });

  describe('getAllDrafts filtering', () => {
    it('filters by inbox folder', async () => {
      const drafts = await db.getAllDrafts({ folder: 'inbox' });
      expect(drafts.map((d) => d.uuid).sort()).toEqual([
        'uuid-multiline',
        'uuid-nulls',
        'uuid-title',
      ]);
    });

    it('filters by archive folder', async () => {
      const drafts = await db.getAllDrafts({ folder: 'archive' });
      expect(drafts.map((d) => d.uuid)).toEqual(['uuid-singleline']);
    });

    it('filters by trash folder', async () => {
      const drafts = await db.getAllDrafts({ folder: 'trash' });
      expect(drafts.map((d) => d.uuid)).toEqual(['uuid-empty']);
    });

    it('filters by flagged state', async () => {
      const drafts = await db.getAllDrafts({ flagged: true });
      expect(drafts.map((d) => d.uuid)).toEqual(['uuid-title']);
    });
  });

  describe('searchDrafts', () => {
    it('extracts the first line as the title in results', async () => {
      const results = await db.searchDrafts('First line');
      expect(results.find((d) => d.uuid === 'uuid-multiline')?.title).toBe('First line title');
    });

    it('matches against ZTITLE', async () => {
      const results = await db.searchDrafts('Explicit');
      expect(results.map((d) => d.uuid)).toContain('uuid-title');
    });

    it('parses ZZZ-wrapped tags in results', async () => {
      const results = await db.searchDrafts('Explicit');
      expect(results.find((d) => d.uuid === 'uuid-title')?.tags).toEqual(['work', 'personal']);
    });

    it('returns an empty array when nothing matches', async () => {
      const results = await db.searchDrafts('zzz-no-match-zzz');
      expect(results).toEqual([]);
    });

    it('escapes single quotes in the search text', async () => {
      const results = await db.searchDrafts("o'brien");
      expect(results).toEqual([]);
    });
  });

  describe('parseCachedTags edge cases', () => {
    let edgeDir: string;
    let edgeDb: DraftsDatabase;

    beforeAll(async () => {
      edgeDir = mkdtempSync(join(tmpdir(), 'drafts-db-tags-'));
      const p = join(edgeDir, 'DraftStore.sqlite');
      const setup = `
        CREATE TABLE ZMANAGEDDRAFT (
          ZUUID TEXT, ZTITLE TEXT, ZCONTENT TEXT, ZCACHED_TAGS TEXT,
          ZCREATED_AT REAL, ZMODIFIED_AT REAL, ZFLAGGED INTEGER, ZFOLDER INTEGER
        );
        INSERT INTO ZMANAGEDDRAFT VALUES
          ('t-trailingz', '', 'x', 'ZZZTODOZZZZ', 0, 30, 0, 0),
          ('t-multiword', '', 'x', 'ZZZread laterZZZ ZZZworkZZZ', 0, 20, 0, 0),
          ('t-embedded', '', 'x', 'ZZZfooZZZbarZZZ', 0, 10, 0, 0);
      `;
      await execFileAsync('sqlite3', [p, setup]);
      edgeDb = new DraftsDatabase(p);
    });

    afterAll(() => rmSync(edgeDir, { recursive: true, force: true }));

    it('keeps a trailing uppercase Z in the tag name', async () => {
      const drafts = await edgeDb.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 't-trailingz')?.tags).toEqual(['TODOZ']);
    });

    it('preserves spaces inside a multi-word tag', async () => {
      const drafts = await edgeDb.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 't-multiword')?.tags).toEqual(['read later', 'work']);
    });

    it('keeps a literal ZZZ inside a tag name', async () => {
      const drafts = await edgeDb.getAllDrafts();
      expect(drafts.find((d) => d.uuid === 't-embedded')?.tags).toEqual(['fooZZZbar']);
    });
  });

  describe('getDraftContent', () => {
    it('returns the full content for an existing uuid', async () => {
      expect(await db.getDraftContent('uuid-multiline')).toBe('First line title\nsecond line');
    });

    it('returns an empty string for empty content', async () => {
      expect(await db.getDraftContent('uuid-empty')).toBe('');
    });

    it('returns an empty string for null content', async () => {
      expect(await db.getDraftContent('uuid-nulls')).toBe('');
    });

    it('returns null for a non-existent uuid', async () => {
      expect(await db.getDraftContent('does-not-exist')).toBeNull();
    });

    it('does not allow SQL injection via a quote in the uuid', async () => {
      // Unescaped, `' OR '1'='1` makes the WHERE always true and leaks a row.
      // Escaped, it matches a literal uuid that does not exist -> null.
      expect(await db.getDraftContent("' OR '1'='1")).toBeNull();
    });

    it('treats a quote-bearing uuid as a literal value, not SQL', async () => {
      expect(await db.getDraftContent("uuid-multiline' --")).toBeNull();
      // The legitimate lookup still works after escaping.
      expect(await db.getDraftContent('uuid-multiline')).toBe('First line title\nsecond line');
    });
  });
});
