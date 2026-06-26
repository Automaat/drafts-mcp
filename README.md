# Drafts MCP Server

Lets Claude (and other AI assistants) talk to the **[Drafts](https://getdrafts.com)** app on your Mac. Create drafts, search and read your notes, append or prepend text, and run Drafts actions — all by chatting.

[![npm](https://img.shields.io/npm/v/@mskalski/drafts-mcp.svg)](https://www.npmjs.com/package/@mskalski/drafts-mcp)
[![release](https://img.shields.io/github/v/release/Automaat/drafts-mcp.svg)](https://github.com/Automaat/drafts-mcp/releases/latest)

> **Works with:** Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf, VS Code.
> **Needs:** the Drafts app on **macOS**. Nothing else — no programming required.

---

## Install (Claude Desktop — easiest, 2 steps)

This is the recommended path. Takes ~2 minutes, no terminal needed.

### 1. Download the installer

Go to the [latest release page](https://github.com/Automaat/drafts-mcp/releases/latest) and download the file ending in **`.mcpb`** (it's near the top, called `drafts-mcp-<version>.mcpb`).

### 2. Double-click the downloaded file

Claude Desktop opens automatically and asks: *"Install Drafts extension?"*. Click **Install**, then enable it.

> Don't have Claude Desktop yet? Get it free from [claude.com/download](https://claude.com/download).

### Try it

Open Claude Desktop and type:

> *Create a draft titled "Shopping list" with milk, eggs, and bread.*

Some other things to try:
- *"Show me all my drafts from the inbox."*
- *"Search my drafts for anything mentioning 'invoice'."*
- *"Append a line to that draft with today's date."*

> **Note:** for **write** actions (create / append / prepend / open / run action) the Drafts app must be **running** — they go through Drafts' URL scheme. Reading and searching work straight from the local database, even if Drafts is closed.

---

## Install (other AI tools)

Already using Claude Code, Codex, Cursor, Windsurf, or VS Code? Pick your tool below. All paths need [Node.js 18+](https://nodejs.org) (except the standalone-binary option at the bottom).

<details>
<summary><b>Claude Code</b></summary>

Same `.mcpb` file as Claude Desktop above — Claude Code accepts it too. Or install via the CLI:

```bash
claude mcp add drafts -- npx -y @mskalski/drafts-mcp
```

</details>

<details>
<summary><b>Codex CLI</b></summary>

```bash
codex mcp add drafts -- npx -y @mskalski/drafts-mcp
```

</details>

<details>
<summary><b>Cursor / Windsurf / VS Code (Continue, Cline, Roo, ...)</b></summary>

Open your client's MCP settings and add:

```json
{
  "mcpServers": {
    "drafts": {
      "command": "npx",
      "args": ["-y", "@mskalski/drafts-mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>No Node.js installed? Use the standalone binary</b></summary>

1. Download the right file from the [latest release](https://github.com/Automaat/drafts-mcp/releases/latest):
   - **Mac (Apple Silicon, M1/M2/M3/M4):** `drafts-mcp-darwin-arm64`
   - **Mac (Intel):** `drafts-mcp-darwin-x64`

2. Make it runnable and bypass Gatekeeper (the binary isn't signed):
   ```bash
   chmod +x ~/Downloads/drafts-mcp-darwin-arm64
   xattr -d com.apple.quarantine ~/Downloads/drafts-mcp-darwin-arm64
   ```

3. Point your AI tool at the binary's full path. Example for Codex:
   ```bash
   codex mcp add drafts -- /Users/you/Downloads/drafts-mcp-darwin-arm64
   ```

</details>

<details>
<summary><b>Run from source</b></summary>

```bash
git clone https://github.com/Automaat/drafts-mcp.git
cd drafts-mcp
npm install
npm run build
```

Then point your client at the built entry point:

```json
{
  "mcpServers": {
    "drafts": {
      "command": "node",
      "args": ["/absolute/path/to/drafts-mcp/build/index.js"]
    }
  }
}
```

</details>

---

## Something not working?

1. **Creating / appending / opening drafts does nothing?** Make sure the **Drafts app is running** — write actions go through Drafts' URL scheme. Reading and searching work even when Drafts is closed.
2. **First write seems to hang?** macOS may show a prompt asking to let your AI tool open Drafts — approve it and try again.
3. **Reads fail?** Confirm Drafts is installed and you can open `~/Library/Group Containers/GTFQ98J4YG.com.agiletortoise.Drafts/`.
4. Still stuck? See [Troubleshooting](#troubleshooting) below.

---

## Tools

| Tool | What it does |
| --- | --- |
| `create_draft` | Create a new draft with content, tags, and an optional action. Returns the new draft's UUID. |
| `get_draft` | Get a draft's full content by UUID (reads the local database). |
| `get_all_drafts` | List all drafts with metadata, filtered by folder or flag. |
| `search_drafts_db` | Full-text search your drafts in the local database. |
| `append_to_draft` | Append text to an existing draft. |
| `prepend_to_draft` | Prepend text to an existing draft. |
| `open_draft` | Open a draft in the Drafts app by UUID or title. |
| `run_action` | Run a named Drafts action on some text. |
| `search_drafts` | Open the Drafts search UI with query / tag / folder filters. |

### Resources

- `draft://uuid/{uuid}` — retrieve a specific draft's content.

## How it works

```
┌─────────────┐   stdio    ┌──────────────────┐   reads    ┌────────────────────┐
│  AI client  │ ◄────────► │   MCP server     │ ─────────► │  DraftStore.sqlite  │
│ (Claude/    │            │  (Node, stdio)   │            │  (local database)   │
│  Codex/...) │            └──────────────────┘            └────────────────────┘
└─────────────┘                     │ writes via x-callback-url
                                    ▼
                            ┌──────────────────┐
                            │   Drafts app     │
                            └──────────────────┘
```

- **Reads** (`get_*`, `search_drafts_db`) query the local Drafts SQLite database in-process (`node:sqlite`, or `bun:sqlite` in the standalone binary) over a persistent read-only connection — works even when Drafts is closed. Falls back to the system `sqlite3` CLI on older Node.
- **Writes** (`create`, `append`, `prepend`, `open`, `run_action`, `search_drafts`) use Drafts' `x-callback-url` scheme. A short-lived Express callback server on a random localhost port captures the response. Retries 3× with exponential backoff.

## CLI reference

```
drafts-mcp [stdio]      Run the MCP server over stdio (default)
drafts-mcp --help       Show help
drafts-mcp --version    Print version
```

## Security

Everything runs locally on your Mac:

- **Reads** query the local Drafts SQLite database directly — no app, network, or cloud involved.
- **Writes** hand a `drafts://x-callback-url` to the macOS `open` command; Drafts then calls back into a short-lived HTTP server the MCP server starts on a random port.
- That callback server lives only while the MCP server is running and only completes requests keyed by an unguessable `randomUUID()` it generated itself. It holds no credentials and carries nothing beyond Drafts' own callback payload.
- No auth tokens, no telemetry, no remote endpoints — your drafts never leave your machine.

## Requirements

- **macOS** — the server shells out to `open` for URL schemes and reads the macOS Drafts group container.
- **[Drafts app](https://getdrafts.com)** installed (and running for write operations).
- **Node.js 18+** — unless you use the standalone binary. Node 22.5+ (mise pins 24) reads the database in-process; Node 18/20 falls back to the `sqlite3` CLI, which must be on `PATH`.

## Develop

```bash
mise install        # tools (node, bun)
mise run install    # npm install
mise run build      # tsc
mise run test       # jest
mise run check      # lint + format + test + version check
mise run mcpb       # build the .mcpb bundle
mise run binary     # build standalone macOS binaries via Bun
```

Repo layout:

- `src/` — TypeScript MCP server (ESM, Node16).
- `mcpb/manifest.json` — `.mcpb` bundle manifest.
- `scripts/build-mcpb.mjs` — pack the `.mcpb`.
- `scripts/build-binary.mjs` — Bun `--compile` per-target binaries.
- `scripts/bump-version.mjs` — single source of truth for the release version.

### Releasing

Run the **Release** workflow (`.github/workflows/release.yml`) via *Actions → Release → Run workflow*. It bumps every version source, tags, builds the `.mcpb` + binaries + npm tarball, publishes to npm (OIDC trusted publishing), and creates the GitHub release.

## Adding a new tool

A tool lives in **three** hand-kept places in `src/index.ts` plus its implementation — keep them in sync:

1. Define a `zod` schema for the arguments.
2. Add a tool entry (name, description, hand-written JSON Schema `inputSchema`) to the `ListToolsRequestSchema` handler — keep it identical to the zod shape.
3. Add a `case` to the `CallToolRequestSchema` switch that parses with the zod schema and calls the implementation.
4. Implement the operation in `DraftsDatabase` (reads) or `DraftsClient` (writes) — never inline SQLite/URL logic in `index.ts`.
5. Add a spec under `src/__tests__/` (read tools run against a throwaway SQLite DB).
6. Add a row to the [Tools](#tools) table above.

## Troubleshooting

### "Failed to query Drafts database"

- Ensure the Drafts app is installed.
- Check the database path: `~/Library/Group Containers/GTFQ98J4YG.com.agiletortoise.Drafts/DraftStore.sqlite`.
- Verify you have read permission for the Group Container.

### "Request timed out" (write operations)

- Make sure the Drafts app is **running**.
- Confirm Drafts can receive URL schemes.

### macOS "cannot be opened because the developer cannot be verified" (binary)

- `xattr -d com.apple.quarantine /path/to/drafts-mcp-darwin-arm64`, or right-click → Open the first time.

### "Connection failed" in the client

- Restart the AI client.
- Double-check the command/path in your MCP config.

## License

MIT
