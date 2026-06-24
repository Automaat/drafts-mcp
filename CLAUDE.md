# drafts-mcp

MCP server bridging AI clients (Claude/Codex/Cursor/...) to the **Drafts** app on macOS. Reads drafts from the local SQLite DB; writes via Drafts' `x-callback-url` scheme. TypeScript, ESM, stdio transport.

## Key Files

- `src/index.ts` — MCP server entry point (`#!/usr/bin/env node`): tool/resource registration + dispatch.
- `src/drafts-db.ts` — `DraftsDatabase`: READ path, shells out to sqlite3 CLI.
- `src/drafts-client.ts` — `DraftsClient`: WRITE path, builds x-callback-url + `open` (fire-and-forget; created UUID read back from the DB).
- `src/version.ts` — GENERATED, do not hand-edit (see Version Sync).
- `src/__tests__/` — jest specs; run real sqlite3 against throwaway DBs.
- `scripts/bump-version.mjs` — single source of truth for release version.
- `mcpb/manifest.json` — .mcpb bundle manifest (carries version). `build/` is tsc output (gitignored); bin target is `build/index.js`.

## Tech Stack

**Language:** TypeScript 6, `strict` mode, target ES2022, module/moduleResolution `Node16`, `isolatedModules`
**Runtime:** Node ≥18 (mise pins node 24), ESM only (`"type": "module"`)
**MCP:** `@modelcontextprotocol/sdk` over `StdioServerTransport`
**Validation:** zod 4
**Testing:** jest 30 + ts-jest (ESM preset)
**Linting:** eslint 10 flat config + prettier
**Tooling:** mise (node, bun); build artifacts via tsc and Bun

## Architecture: read vs write split

This is the central design fact. Every tool falls into one of two paths.

**READ path — `DraftsDatabase` (`drafts-db.ts`)**
- Tools: `get_draft`, `get_all_drafts`, `search_drafts_db`, and the `draft://uuid/{uuid}` resource.
- Shells out to the system `sqlite3 -json` CLI against `~/Library/Group Containers/GTFQ98J4YG.com.agiletortoise.Drafts/DraftStore.sqlite`.
- Works even when the Drafts app is closed.
- Cocoa epoch: DB timestamps are seconds since 2001-01-01; convert with `COCOA_EPOCH_OFFSET`.
- Title fallback: `ZTITLE` is usually empty — derive the display title from the first line of `ZCONTENT` (mirror the existing `CASE` expression in any new query).

**WRITE path — `DraftsClient` (`drafts-client.ts`)**
- Tools: `create_draft`, `append_to_draft`, `prepend_to_draft`, `open_draft`, `run_action`, `search_drafts`.
- Builds a `drafts://x-callback-url/...` URL and runs `open <url>` **fire-and-forget** — no `x-success`/`x-error`/`x-cancel` callbacks, so Drafts opens nothing and macOS never routes an `http://` callback to the browser (issue #51).
- No callback HTTP server. Because writes are fire-and-forget, they cannot detect Drafts-side errors; tool responses say a request was "sent to Drafts", not that it succeeded.
- `create_draft` returns the new draft's UUID by reading the local DB: capture `getMaxPk()` before, `open` the create URL, then poll `findCreatedDraftUuid(beforePk, text)` (Core Data `Z_PK` watermark) until it appears or `createLookupTimeout` (10s) elapses. Creates are serialized (`createChain`) so concurrent ones get unambiguous watermarks.
- Requires the Drafts app to be installed (handles a `drafts://` URL). Retries 3× with `retryDelay` backoff (`executeWithRetry`); the create poll swallows transient DB errors so a retry never re-fires the create.

`get_draft` was deliberately moved to the READ path (see `// PATCHED` comments) so reads never depend on the app being open — keep it that way.

## Development Workflow

### Adding a new MCP tool

A tool lives in **three** hand-maintained places in `src/index.ts` plus its implementation. All three must stay in sync — there is no single source.

1. Define a zod schema (runtime validation), e.g. `const FooSchema = z.object({ ... })`.
2. Add a tool entry to the `ListToolsRequestSchema` handler with a hand-written JSON Schema `inputSchema` (this is what clients see — it duplicates the zod shape; keep them identical).
3. Add a `case 'foo':` to the `CallToolRequestSchema` switch: `const args = FooSchema.parse(request.params.arguments)`, call the implementation, return `{ content: [{ type: 'text', text: ... }] }`.
4. Implement the operation in `DraftsDatabase` (read) or `DraftsClient` (write) — never inline DB/URL logic in `index.ts`.
5. Add a `__tests__` spec; for read tools test against a throwaway sqlite DB (see existing fixture pattern).
6. Update the Tools table in `README.md`.

### Running locally

```bash
mise run build      # tsc -> build/
node build/index.js --version   # smoke test the CLI
node build/index.js --help
```

The server speaks MCP over stdio; there is no interactive REPL. Test behavior through the jest suite or a connected MCP client.

## Quality Gates

Before committing, run the full gate (matches CI exactly):

```bash
mise run check      # = lint + format:check + test + version --check
```

Individual gates:

```bash
mise run lint               # eslint src --ext .ts
npm run format:check        # prettier --check
mise run test               # jest (40s timeout; runs real sqlite3)
node scripts/bump-version.mjs --check   # version drift guard
mise run build              # tsc must succeed
```

CI (`.github/workflows/ci.yml`) runs the same on **macos-latest** (tests need the `sqlite3` CLI and the code is macOS-only). A separate ubuntu job runs only the version-consistency check. Both must be green.

## Version Sync (release invariant)

`package.json` is the canonical version. It must equal the version in `package-lock.json`, `src/version.ts`, and `mcpb/manifest.json` at all times — `bump-version.mjs --check` enforces this in CI and will fail the build on drift.

- **Never** hand-edit `src/version.ts` (generated) or version fields in the other files.
- To change versions locally: `node scripts/bump-version.mjs <x.y.z>` (or `--bump=patch|minor|major`).
- Releases are cut by the **Release** workflow (`.github/workflows/release.yml`, `workflow_dispatch`): it bumps all sources, tags, builds `.mcpb` + binaries + npm tarball, publishes to npm via OIDC, and creates the GitHub release. Do not tag or publish by hand.

## Git & Commits

- **Format:** `type(scope): description` — scope required. Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
- **Limits:** title ≤50 chars; body ≤72 chars/line.
- Sign commits: `git commit -s -S`.
- Never include PR/issue refs (`#123`) or AI attribution (`Co-Authored-By`, "Generated by ...") in messages.
- Comply with hooks — fix the root cause, never `--no-verify`.
- Infra changes use infra scopes: `ci(actions):`, `build(packaging):`, `test(...)`, `docs(...)` — not `feat`/`fix`.

## Anti-Patterns

**AVOID:**

- ❌ `console.log` anywhere. stdout is the MCP stdio channel — logging to it corrupts the protocol. Use `console.error` only (the eslint `no-console` rule already restricts to `error`/`warn`).
- ❌ Adding a tool to only one or two of the three `index.ts` sites (zod schema / `ListTools` JSON Schema / switch case). Out-of-sync = silent validation gaps or unhandled tools.
- ❌ Editing `src/version.ts` or version fields by hand → breaks the version-sync gate.
- ❌ Unescaped string interpolation into SQL. **Known constraint:** `getDraftContent` and `getAllDrafts` interpolate `uuid`/`folder` directly (folder is an enum; uuid comes from DB-listed values). Only `searchDrafts` escapes single quotes (`replace(/'/g, "''")`). Any new query that takes free-text input MUST escape the same way (or parameterize) — do not copy the raw-interpolation pattern for user-supplied text.
- ❌ Omitting `.js` extensions on relative imports. Node16 ESM resolution requires `import { X } from './foo.js'` even though the source is `foo.ts`.
- ❌ Inlining sqlite/URL logic in `index.ts` — keep reads in `DraftsDatabase`, writes in `DraftsClient`.
- ❌ Suppressing lint with inline disable comments or skipping hooks. Fix the root cause.

## Testing Conventions

- Read-path tests create a throwaway DB with `mkdtempSync`, seed `ZMANAGEDDRAFT` rows via the `sqlite3` CLI, and assert real query behavior — no DB mocking. Follow the fixture in `src/__tests__/drafts-db.test.ts` (covers title fallback, folder/flag mapping, Cocoa timestamps, quote escaping, empty/null rows).
- Cover edge cases the schema allows: empty content, null columns, no-match (empty `[]`), and quote-injection inputs.
- Tests run with ESM jest; keep `.js` import specifiers in specs too.

## Common Commands

```bash
mise install        # install pinned tools (node, bun)
mise run install    # npm install
mise run build      # tsc
mise run test       # jest
mise run lint       # eslint
mise run format     # prettier --write
mise run check      # full quality gate (lint + format + test + version)
mise run mcpb       # build .mcpb bundle
mise run binary     # build standalone macOS binaries (Bun)
```

## Extensibility

Add sections as the project grows (new transport, new write endpoints, non-macOS support). Keep entries concrete: real file paths, real commands, real invariants. When a recurring task gains a third special case, promote it to a numbered workflow here.
