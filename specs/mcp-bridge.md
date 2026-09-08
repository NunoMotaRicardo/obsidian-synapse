# MCP bridge (`src/mcpBridge.ts`)

Allows the local-model ReAct loop to call tools provided by stdio MCP servers discovered
from `_synapse/.mcp.json`, in addition to the built-in vault tools.

## Overview

`McpBridgeSession` manages the full lifecycle of one or more MCP server processes for the
duration of a single local-model run (currently: one batch-loop item, via `runExecutor.ts`):

1. **`start(vaultBasePath)`** — reads `_synapse/.mcp.json`, spawns all configured servers,
   negotiates `initialize` + `tools/list` via JSON-RPC 2.0, returns a flat `LocalTool[]`.
2. The caller merges these with the built-in `vaultTools` and passes the combined list to
   `executeLocalProviderQuery()`.
3. **`stop()`** — kills all spawned processes, including their child processes (on win32, servers
   started via `npx`/`npm`/`pnpm`/`yarn` run as a `.cmd` wrapper, so the spawned process is
   `cmd.exe` with the real server as a grandchild; `ChildProcess#kill()` alone would leave that
   grandchild running, so `stop()` uses `taskkill /pid <pid> /t /f` first on win32, falling back to
   a direct `kill()`). Always called in a `finally` block so servers are shut down even if the
   ReAct loop throws.

One session per run. Sessions are never reused across calls.

## Config format (`_synapse/.mcp.json`)

Follows the same structure used by the Claude Agent SDK `plugins` option:

```jsonc
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "sk-..." }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

`env` is optional. If the file is absent or contains no `mcpServers`, `start()` returns `[]`
and execution continues with vault tools only.

## JSON-RPC protocol

Each MCP server is a long-running process communicating over **stdin/stdout** with newline-delimited
JSON-RPC 2.0 messages. The bridge:

- Uses a monotonically incrementing integer `id` for each request.
- Sends one line per request/notification (terminated with `\n`).
- Reads lines from stdout and dispatches responses to matching pending requests by `id`.
- Logs stderr to `console.warn` (prefixed `[synapse] MCP server "<name>" stderr:`).
- Limits request wait times with a default 15-second timeout to prevent locking up the loop.

### Handshake sequence

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"synapse","version":"1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{...}}
→ {"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
```

### Tool calls

```
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"brave_web_search","arguments":{...}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}]}}
```

Content items with `type:"text"` are joined as plain text. Other item types are JSON-stringified.

## LocalTool wrapping

Each MCP tool descriptor (`name`, `description`, `inputSchema`) is converted to a `LocalTool`:

| MCP field | LocalTool field |
|---|---|
| `name` | `name` |
| `description` (or fallback) | `description` |
| `inputSchema` (or `{}`) | `parameters` |
| `tools/call` JSON-RPC | `execute(args, _app)` |

The `app` parameter is unused — MCP tools handle their own I/O.

## Error handling

- **Config absent/unreadable** — `start()` catches the read/parse error and returns `[]`.
- **Server spawn failure** — logged to `console.error`; other servers continue. On Windows, command aliases like `npx`, `npm`, `pnpm`, and `yarn` are automatically resolved to their corresponding `.cmd` extension to prevent spawn errors.
- **Request Timeout** — if a server does not respond to a JSON-RPC request within 15 seconds, the request promise is rejected, preventing hung servers from freezing execution.
- **JSON-RPC error response** — `execute()` catches it and returns an error string (never throws).
- **Process exit during loop** — pending promises are rejected; `execute()` catches and returns error string.
- Errors never propagate to crash the caller.

## Integration point

`src/runExecutor.ts` → `executeWithLocalModel()`:

```ts
const mcpSession = new McpBridgeSession();
let mcpTools: LocalTool[] = [];
if (supportsTools) {
    try {
        mcpTools = await mcpSession.start(vaultBasePath);
    } catch (e) {
        console.warn('[synapse] MCP bridge start failed (continuing without MCP tools):', e);
    }
}
try {
    const allTools = supportsTools ? [...vaultTools, ...mcpTools] : [];
    const res = await executeLocalProviderQuery(providerConfig, {
        prompt: fullPrompt,
        ...(allTools.length > 0 ? {tools: allTools, app: plugin.app} : {}),
    });
    // ...
} finally {
    await mcpSession.stop();
}
```
