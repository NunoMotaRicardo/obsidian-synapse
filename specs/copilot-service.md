# copilot-service

Source: `src/copilot.ts` — class `CopilotService`. The single place the plugin touches
`@github/copilot-sdk`. Every other module goes through this wrapper.

## Responsibilities

- Own one `CopilotClient` and its lifecycle (`ensureConnected`, `stop`).
- Create / resume / list / delete sessions with plugin-wide defaults (`clientName: 'obsidian-sidekick'`).
- One-shot helpers: `chat()` (ephemeral session) and `inlineChat()` (persisted session) used by
  editor actions, ghost text, search, triggers, and bots.
- Re-export all SDK types consumed elsewhere so the SDK import surface stays in one file.

## SDK 1.0 contract (post-migration)

- Client construction uses `connection`:
  - Local: `RuntimeConnection.forStdio({ path })` where `path` comes from runtime-manager
    resolution (settings override → global npm → WinGet links → SDK fallback).
  - Remote: `RuntimeConnection.forUri(url)`.
- Auth: `gitHubToken` (capital H) and `useLoggedInUser` client options.
- Environment: pass the allowlisted `cleanEnv()` and `workingDirectory: os.homedir()`.
- Connection state: the SDK no longer exposes `getState()`/`ConnectionState`. The service
  tracks its own `ConnectionState` (`disconnected | connecting | connected | error`) — set
  around `start()` — and keeps exposing `getState()` to the rest of the plugin.
- On `start()` failure, the error surfaced to the UI must mention the likely cause
  (CLI missing or too old → "run `copilot update`").
- `ping()` returns `timestamp: string` (ISO), optionally `protocolVersion`.
- Message history: `session.getEvents()` (was `getMessages()`).
- MCP config types: `MCPServerConfig = MCPStdioServerConfig | MCPHTTPServerConfig`.

## BYOK provider injection (#25)

When a non-GitHub provider preset is active, `CopilotService` receives `provider` (a
`ProviderConfig`) and optionally `streaming` at construction time (set in
`main.ts` from settings via `buildProviderConfig()`). Both `chat()` and `inlineChat()` auto-
inject `provider` and `streaming` into their `createSession()` calls so that **all** inline/
editor operations (rewrite, edit, structure, image extraction, ghost text, etc.) route through
the BYOK endpoint — not just the chat panel.

`buildProviderConfig()` is a shared method on `SidekickPlugin` (`main.ts`) used by both the
service constructor and `buildSessionConfig()` in `sidekickView.ts`, eliminating the previous
duplication of the `typeMap` and provider-config assembly.

The `streaming` flag is set to `false` for the `foundry-local` preset (matching the chat-panel
behavior), and omitted otherwise (SDK default is streaming).

## Named Agent Model Binding & Routing (#5)

Named agents parsed from `*.agent.md` carry an optional `model` binding (Claude model ID or local backend reference). `toCustomAgentConfig()` converts vault `AgentConfig` objects into SDK `AgentDefinition` (`CustomAgentConfig`) objects with their `model`, `description`, `prompt`, `tools`, and `skills` intact.

`AgentService` includes a internal routing layer (`routeQueryOptions`) that intercepts queries. When a named agent is specified (`agent`) and its matching `AgentDefinition` carries a model binding (`model`), `AgentService` routes the request's effective model to the bound model backend. Tool delegation to subagents via the Agent tool similarly resolves each subagent's bound model.

## Dynamic Delegation via MCP Tool (#8)

Tier-1 Claude sessions can dynamically delegate sub-work to a cheap/local-backed agent using an in-process MCP server (`delegation`).
- **Gating:** Gated on local-backend availability/capability (`isLocalBackendAvailable()`, checking if `providerConfig` has a valid `baseUrl`). If not configured or unavailable, the delegation MCP server is omitted from session options.
- **Tools exposed:** `cheap_generate` (for single prompts/sub-tasks) and `bulk_summarize` (for multi-item summaries, processed in parallel via `Promise.allSettled`).
- **Routing & Cost Control:** The in-process tool handler executes sub-tasks directly via `executeLocalProviderQuery()`, keeping routing, formatting, and cost strictly under plugin control. `routeQueryOptions()` automatically merges the delegation MCP server into `mcpServers` whenever the local backend is available.
- **Caching:** The resolved default model ID is cached per base URL to avoid repeated `fetchProviderModels` HTTP calls. The delegation MCP server instance is cached but automatically invalidated when `isLocalBackendAvailable()` returns false. Call `clearDelegationCache()` when provider config changes.

## Session options passed through (selected)

| Option | Source |
|---|---|
| `model` | toolbar / agent frontmatter / settings / AgentService agent routing |
| `reasoningEffort` | settings + toolbar brain menu, only when `model.capabilities.supports.reasoningEffort` |
| `reasoningSummary` | settings + toolbar brain menu (issue 0003), same gating as `reasoningEffort` |
| `contextTier` | planned — issue 0004 |
| `infiniteSessions` | settings `infiniteSessionsEnabled` (issue #5) — `{ enabled }` config; omitted when `true` (SDK default), passed as `{ enabled: false }` when disabled |
| `systemMessage` | agent body / built-in prompts |
| `customAgents`, `agent` | config-loader agents (bound models converted via `toCustomAgentConfig`) |
| `mcpServers` | config-loader `tools/mcp.json` |
| `skillDirectories`, `disabledSkills` | config-loader skills |
| `onPermissionRequest` | tool-approval modal or `approveAll` |
| `onUserInputRequest`, `onElicitationRequest` | modals |
| `provider` | BYOK settings — injected by both `buildSessionConfig` (chat) and `chat()`/`inlineChat()` (inline) |
| `streaming` | `false` for `foundry-local`; omitted otherwise |

## Version info callback (#15)

After a successful connect in `ensureConnected()`, the service calls `client.getStatus()`
fire-and-forget (try/catch — must not block or break the connect path). If it succeeds, the
service caches the `GetStatusResponse` and fires the `onVersionInfo` constructor callback:

```
onVersionInfo?: (status: {version: string; protocolVersion: number}, resolvedPath: string) => void
```

This follows the same constructor callback pattern as `onListModels`. `main.ts` wires it to
log `Sidekick: Copilot CLI v%s (protocol %d)` to console. The settings UI reads the cached
version info from the service (`getVersionInfo()`) to display it alongside the resolved
binary path.

The SDK already checks protocol mismatch during `client.start()` and throws — so there is no
separate mismatch Notice on successful connect. `getStatus()` is purely informational.

## Ollama connection error handling (#25)

When the `ollama` preset is active and a `chat()` or `inlineChat()` call fails with a
connection/network error, the service fires its `onConnectionError` callback. Detection uses
`isConnectionError()` which matches: `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`,
`EHOSTUNREACH`, `fetch failed`, `network`, `socket hang up`. It intentionally avoids matching
bare `connect` — that would false-positive on CLI spawn errors ("Could not connect to the
Copilot CLI (spawn ENOENT)") or SDK session messages ("disconnect failed").

`main.ts` wires this to an Obsidian `Notice` (8 seconds):

> Could not reach Ollama at localhost:11434. Is it running? Start it with `ollama serve`.

Text-only — no retry button, no auto-retry. The existing Settings > Models **Test** button
is the manual retry path. The `onConnectionError` callback pattern keeps `CopilotService`
free of `obsidian` imports.

## Ollama UX polish (#30)

`src/ollamaErrors.ts` provides Ollama-specific error detection and user-friendly message
mapping, used when `providerPreset === 'ollama'`:

- `friendlyOllamaError(rawMessage)` — matches common error patterns (ECONNREFUSED, model not
  found, out of memory, tool-use unsupported, etc.) and returns a friendly message, or `null`.
- `isToolUseError(msg)` / `isVisionError(msg)` — detect tool-use and vision capability errors.
- `TOOL_USE_GUIDANCE` / `VISION_GUIDANCE` — actionable suggestions with alternative model names.

Chat-side integration (`sidekickView.ts`):
- `session.error` events and `handleSend` catch blocks use `formatErrorForChat()` which
  delegates to `friendlyOllamaError()` when the Ollama preset is active.
- `tool.execution_complete` failures that match tool-use or vision patterns show additional
  contextual guidance messages in the chat.

Settings-side integration (`settings.ts`):
- The Provider setting description changes to Ollama setup instructions when the Ollama preset
  is selected (install, serve, pull, test).
- The Test button shows Ollama-specific notices: connection failures suggest "ollama serve",
  zero models suggest "ollama pull", successful connection with no model selected prompts the
  user to pick one.

## Request Timeouts and Cancellation

Both `chat()` and `inlineChat()` accept an optional `timeout` (milliseconds). The private
`withTimeout(ms)` helper creates an `AbortController` and a timer that aborts after the
specified duration. `handleTimeoutError()` inspects the abort signal in catch blocks and
throws a descriptive timeout error. The `AbortController` is passed to the SDK's `query()`
via its `abortController` option.

### Adaptive Indexing/Search Timeouts

A shared helper `getAdaptiveTimeout(app, scopePath, configuredTimeoutSec)` calculates the
client-side timeout in milliseconds dynamically based on the number of files in scope.

- Formula: `Math.max(120_000, Math.min(600_000, 30_000 + fileCount * 200))` (base 30s +
  200ms per file, floor 120s, cap 10 minutes).
- The result is compared against the user's `providerRequestTimeout` setting (seconds,
  converted to ms), and the larger value is used.
- Scope calculation:
  - Telegram bot (`telegramBot.ts`): entire vault (`scopePath` undefined).
  - Search panel (`searchPanel.ts`): active search directory (`searchWorkingDir`).

## Public API surface

The `provider` and `providerStreaming` fields are private — consumed only
internally by `chat()` and `inlineChat()`. No public getters are exposed for them; callers
that need provider config (e.g. `buildSessionConfig`) receive it directly from `main.ts`.

## Invariants

- No other module imports `@github/copilot-sdk` directly (modals import types only — keep
  type-only imports acceptable).
- `stop()` is called from plugin `onunload()`; must not throw.
- All public methods call `ensureConnected()` first; a broken client is recreated, never reused.
