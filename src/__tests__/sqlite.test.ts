import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteReader } from '../sqlite.js';

const execFileAsync = promisify(execFile);

// SqliteReader has two interchangeable backends: an in-process driver
// (node:sqlite / bun:sqlite) and the sqlite3 CLI. These tests pin down that
// both return identical results so the fast path is a drop-in for the fallback.
describe('SqliteReader', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-reader-'));
    dbPath = join(dir, 'test.sqlite');
    await execFileAsync('sqlite3', [
      dbPath,
      'CREATE TABLE t (id INTEGER, name TEXT, score REAL, note TEXT);' +
        "INSERT INTO t VALUES (1, 'alpha', 1.5, NULL), (2, 'beta', 2.5, 'has '' quote');",
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('auto (in-process) and cli drivers return identical rows', async () => {
    const auto = new SqliteReader(dbPath, 'auto');
    const cli = new SqliteReader(dbPath, 'cli');
    const sql = 'SELECT id, name, score, note FROM t ORDER BY id';

    const autoRows = await auto.query(sql);
    const cliRows = await cli.query(sql);

    expect(autoRows).toEqual(cliRows);
    expect(autoRows).toEqual([
      { id: 1, name: 'alpha', score: 1.5, note: null },
      { id: 2, name: 'beta', score: 2.5, note: 'has ' + "' quote" },
    ]);
    auto.dispose();
  });

  it('returns an empty array when nothing matches (both drivers)', async () => {
    const auto = new SqliteReader(dbPath, 'auto');
    const cli = new SqliteReader(dbPath, 'cli');
    expect(await auto.query('SELECT id FROM t WHERE id = 999')).toEqual([]);
    expect(await cli.query('SELECT id FROM t WHERE id = 999')).toEqual([]);
    auto.dispose();
  });

  it('serves many queries from one persistent connection', async () => {
    const reader = new SqliteReader(dbPath, 'auto');
    for (let i = 0; i < 50; i++) {
      const rows = await reader.query('SELECT COUNT(*) as c FROM t');
      expect(rows[0].c).toBe(2);
    }
    reader.dispose();
  });

  it('uses the in-process driver on this runtime (Node >=22.5 / Bun)', async () => {
    // Guards against a silent regression to the slow CLI path: the parity tests
    // pass even if auto falls back to the CLI, so assert the resolved backend.
    const reader = new SqliteReader(dbPath, 'auto');
    await reader.query('SELECT 1 as one');
    expect(reader.activeDriver).toBe('bun' in process.versions ? 'bun-sqlite' : 'node-sqlite');
    reader.dispose();
  });

  it('reports the cli backend when forced to cli mode', async () => {
    const reader = new SqliteReader(dbPath, 'cli');
    await reader.query('SELECT 1 as one');
    expect(reader.activeDriver).toBe('cli');
    reader.dispose();
  });
});
