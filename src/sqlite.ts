import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type SqliteDriver = 'auto' | 'cli';
// Which backend a reader ended up using — surfaced for diagnostics and tests.
export type ActiveDriver = 'pending' | 'node-sqlite' | 'bun-sqlite' | 'cli';

// One row of a query result, keyed by column alias — the same shape the
// `sqlite3 -json` CLI emits and that node:sqlite / bun:sqlite return from .all().
type Row = Record<string, unknown>;

// The slice of an in-process SQLite driver we rely on. Both node:sqlite
// (DatabaseSync) and bun:sqlite (Database) satisfy it.
interface InProcessDb {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

interface Driver {
  label: ActiveDriver;
  open: (dbPath: string) => InProcessDb;
}

// Reads the Drafts SQLite DB. Prefers an in-process driver with a persistent
// read-only connection (bun:sqlite under Bun, node:sqlite under Node >=22.5),
// which is ~25x faster than spawning the `sqlite3` CLI per query. Falls back to
// the `sqlite3 -json` CLI on older runtimes or any in-process failure, so reads
// keep working everywhere the CLI-only implementation did.
//
// A persistent connection stays current: SQLite runs each statement in its own
// read transaction (autocommit), so committed writes from the Drafts app are
// visible to the next query without reopening.
export class SqliteReader {
  private dbPath: string;
  private mode: SqliteDriver;
  private conn: InProcessDb | null = null;
  // null = not yet probed; a Driver once one loads; false once we know no
  // in-process driver is usable on this runtime (then we stay on the CLI).
  private driver: Driver | null | false = null;
  private active: ActiveDriver = 'pending';

  constructor(dbPath: string, mode: SqliteDriver = 'auto') {
    this.dbPath = dbPath;
    this.mode = mode;
    if (mode === 'cli') this.driver = false;
  }

  // The backend the last query used (or would use). 'pending' until the first
  // query resolves a driver.
  get activeDriver(): ActiveDriver {
    return this.active;
  }

  async query(sql: string): Promise<Row[]> {
    if (this.mode !== 'cli') {
      try {
        const conn = this.connection();
        if (conn) {
          const rows = conn.prepare(sql).all() as Row[];
          return rows;
        }
      } catch {
        // A persistent connection can go stale (DB checkpointed or replaced) or
        // the driver can choke on a transiently locked DB. Drop it and serve
        // this call from the CLI; the next call retries the in-process path.
        this.dispose();
      }
    }
    const rows = await this.queryViaCli(sql);
    this.active = 'cli';
    return rows;
  }

  private connection(): InProcessDb | null {
    if (this.conn) return this.conn;
    if (this.driver === false) return null;
    if (this.driver === null) {
      this.driver = loadDriver() ?? false;
      if (this.driver === false) return null;
    }
    this.conn = this.driver.open(this.dbPath);
    this.active = this.driver.label;
    return this.conn;
  }

  private async queryViaCli(sql: string): Promise<Row[]> {
    // sqlite3 -json emits an empty string (not "[]") when no rows match.
    const { stdout } = await execFileAsync('sqlite3', [this.dbPath, '-json', sql]);
    const trimmed = stdout.trim();
    return trimmed ? (JSON.parse(trimmed) as Row[]) : [];
  }

  dispose(): void {
    try {
      this.conn?.close();
    } catch {
      // best-effort; the OS reaps the fd on exit anyway
    }
    this.conn = null;
  }
}

// Resolve the best in-process driver for the current runtime, or null if none
// is available (older Node without node:sqlite). Synchronous and resolver-free:
// it uses process.getBuiltinModule for node:sqlite (which bundlers and test
// runners can mangle when handed a dynamic `import('node:sqlite')`).
function loadDriver(): Driver | null {
  if (typeof process === 'undefined') return null;

  // Bun ships bun:sqlite and does not implement node:sqlite. require() resolves
  // the builtin synchronously inside the compiled binary.
  if (process.versions && 'bun' in process.versions) {
    try {
      const { createRequire } = process.getBuiltinModule('node:module');
      const bunRequire = createRequire(import.meta.url);
      const { Database } = bunRequire('bun:sqlite') as {
        Database: new (path: string, opts: { readonly: boolean }) => InProcessDb;
      };
      return { label: 'bun-sqlite', open: (path) => new Database(path, { readonly: true }) };
    } catch {
      return null;
    }
  }

  // Node >=22.3 exposes builtins via getBuiltinModule; node:sqlite landed in
  // 22.5 (flagged) and is unflagged in 24. Older Node lacks the method entirely.
  if (typeof process.getBuiltinModule !== 'function') return null;
  try {
    const mod = process.getBuiltinModule('node:sqlite') as
      | { DatabaseSync: new (path: string, opts: { readOnly: boolean }) => InProcessDb }
      | undefined;
    if (mod?.DatabaseSync) {
      const DatabaseSync = mod.DatabaseSync;
      return { label: 'node-sqlite', open: (path) => new DatabaseSync(path, { readOnly: true }) };
    }
  } catch {
    // getBuiltinModule throws when the builtin is unavailable on this runtime
  }
  return null;
}
