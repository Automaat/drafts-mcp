# Drafts MCP Server

MCP server for [Drafts](https://getdrafts.com) app integration, enabling Claude to interact with your Drafts notes via the Model Context Protocol.

## Features

- **Create drafts** - Create new drafts with content, tags, and optional actions
- **Get draft** - Retrieve specific draft by UUID
- **Get all drafts** - List all drafts with metadata (reads from local SQLite database)
- **Search drafts** - Full-text search in local database
- **Append/Prepend** - Add text to existing drafts
- **Open draft** - Open draft in Drafts app
- **Run actions** - Execute Drafts actions on text
- **Search UI** - Open Drafts search interface with filters

## Requirements

- macOS (required for URL scheme integration)
- [Drafts app](https://getdrafts.com) installed
- Node.js 22+ (managed via mise)
- [mise](https://mise.jdx.dev) for dependency management

## Installation

### 1. Install dependencies

```bash
# Install mise if not already installed
curl https://mise.run | sh

# Install Node.js via mise
mise install

# Install npm packages
npm install
```

### 2. Build the project

```bash
npm run build
```

### 3. Configure Claude Desktop

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "drafts": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/sideprojects/drafts-mcp/build/index.js"]
    }
  }
}
```

Replace `/Users/YOUR_USERNAME/sideprojects/drafts-mcp` with your actual project path.

### 4. Restart Claude Desktop

## Usage

Once configured, Claude can use the following tools:

### create_draft

Create a new draft:

```typescript
{
  text: "Draft content",
  tags?: ["tag1", "tag2"],
  action?: "Action Name",
  folder?: "inbox" | "archive"
}
```

### get_draft

Retrieve a draft by UUID:

```typescript
{
  uuid: "draft-uuid-here"
}
```

### get_all_drafts

Get list of all drafts with metadata by reading from local database:

```typescript
{
  folder?: "inbox" | "archive" | "trash" | "all",
  flagged?: boolean
}
```

Returns array of drafts with uuid, title, tags, timestamps, flags.

### search_drafts_db

Search drafts by text content in local database:

```typescript
{
  query: "search text"
}
```

Returns array of matching drafts.

### append_to_draft

Append text to existing draft:

```typescript
{
  uuid: "draft-uuid-here",
  text: "Text to append"
}
```

### prepend_to_draft

Prepend text to existing draft:

```typescript
{
  uuid: "draft-uuid-here",
  text: "Text to prepend"
}
```

### open_draft

Open draft in Drafts app:

```typescript
{
  uuid?: "draft-uuid-here",
  title?: "Draft Title"
}
```

### run_action

Execute a Drafts action:

```typescript
{
  action: "Action Name",
  text: "Text to process"
}
```

### search_drafts

Open Drafts search UI:

```typescript
{
  query?: "search query",
  tag?: "tag-name",
  folder?: "inbox" | "archive" | "flagged" | "trash" | "all"
}
```

## Resources

The server exposes draft content via resources:

- `draft://uuid/{uuid}` - Retrieve specific draft content

## Development

### Build

```bash
npm run build
```

### Watch mode

```bash
npm run watch
```

### Test

```bash
npm test
npm run test:watch
```

### Lint

```bash
npm run lint
npm run lint:fix
```

### Format

```bash
npm run format
npm run format:check
```

## Architecture

- **Callback Server** - Express server on random port handling x-callback-url responses
- **Drafts Client** - URL scheme wrapper with retry logic
- **Drafts Database** - Direct SQLite access to Drafts database for querying
- **MCP Server** - stdio transport, exposes tools and resources
- **Retry Logic** - 3 attempts with exponential backoff

## Limitations

- **macOS only** - Uses `open` command for URL schemes and local database access
- **Drafts app required** - Must be running for write operations (create, append, prepend)
- **Read-only queries** - Database queries are read-only; modifications use URL schemes
- **UI for search** - `search_drafts` URL scheme opens UI (use `search_drafts_db` for programmatic search)

## Troubleshooting

### "Failed to query Drafts database"

- Ensure Drafts app is installed
- Check database path: `~/Library/Group Containers/GTFQ98J4YG.com.agiletortoise.Drafts/DraftStore.sqlite`
- Verify you have read permissions to the Group Container

### "Request timed out"

- Ensure Drafts app is running
- Check Drafts has permission to receive URL schemes
- Verify callback server can bind to localhost

### "Connection failed"

- Restart Claude Desktop
- Check MCP server config path is correct
- Verify Node.js version with `mise current`

## License

MIT
