# agent-service

Source: `src/agentService.ts` — class `AgentService`. The single place the plugin touches
`@anthropic-ai/claude-agent-sdk`. Every other module goes through this wrapper.

> **Module naming:** The spec filename is `agent-service.md`. The live class and all code references use `AgentService`.

## Responsibilities

- Build query options (`pathToClaudeCodeExecutable`, `env`, `model`, `plugins`, `skills`, etc.)
  and invoke `query()` from the Agent SDK.
- Manage session list/delete/rename via `listSessions()`, `deleteSession()`, `renameSession()`.
- One-shot helpers: `chat()` (ephemeral, no session) and `inlineChat()` (persisted session)
  used by editor actions, search, triggers, and bots.
- Re-export all SDK types consumed elsewhere so the SDK import surface stays in one file.
- Track own `ConnectionState` (`'disconnected' | 'connecting' | 'connected' | 'error'`) around
  resolution and first query attempt.

## Agent SDK model

The Claude Agent SDK spawns the `claude` CLI **per query** — there is no persistent connection.
`query()` is the primary entry point and returns an `AsyncGenerator<SDKMessage>`. The plugin
wraps it in `sendAndWaitWithAbort()` for timeout + cancellation.

Key query option fields used:

| Option | Source |
|---|---|
| `pathToClaudeCodeExecutable` | `resolveCliPath()` → `runtimeManager.resolveDefaultCliPath()` |
| `env` | `buildEnv()` — allowlisted env via `cleanEnv()`, plus `ANTHROPIC_API_KEY` for API-key auth |
| `model` | toolbar / agent frontmatter / settings |
| `reasoningEffort` | settings + toolbar reasoning menu (brain icon), only when the model supports it |
| `reasoningSummary` | settings + toolbar reasoning menu (brain icon), same gating |
| `contextTier` | settings `contextTier` (`'default'` or `'long_context'`); omitted when `'default'` |
| `infiniteSessions` | settings `infiniteSessionsEnabled`; omitted when `true` (SDK default) |
| `systemPrompt` | agent body / built-in prompt |
| `plugins` | `_synapse/` vault folder registered as local SDK plugin (`{type: 'local', path: ...}`) |
| `skills` | enabled skill names array from toolbar |
| `canUseTool` | tool-approval modal or `approveAll` |
| `onElicitation` | elicitation modal |
| `mcpServers` | delegation MCP server when local backend is available |

## CLI resolution

`AgentService.resolveCliPath()` returns a `ResolvedCliPath`:

1. If `claudeLocation` is set in settings, validate and use it (`source: 'settings'`).
2. Otherwise, call `resolveDefaultCliPath()` from `runtimeManager.ts` which walks the chain:
   global npm → OS links (WinGet, `~/.claude/bin/`) → SDK fallback.

Before each query, `fs.access(resolved.path)` is called to surface a clear "binary not found"
error before attempting to spawn.

On first resolution, `getCliVersion(resolved.path)` is called fire-and-forget (try/catch — must
not block). On success, the `onVersionInfo` constructor callback is fired with
`{version, protocolVersion, path}`. `main.ts` wires this to a console log; the settings UI
reads `getVersionInfo()` to display the resolved binary path, source, and version.

## Auth model

Dual auth via `buildEnv()`:

- **Subscription (OAuth):** The `claude` CLI manages its own OAuth login. No `ANTHROPIC_API_KEY`
  is set; the CLI picks up the stored credential automatically.
- **API key:** `ANTHROPIC_API_KEY` is injected into the subprocess env from `auth.apiKey`.

## Named Agent Model Binding & Routing

Named agents parsed from `_synapse/agents/*.md` carry an optional `model` binding (Claude
model alias or local backend model ID).

`AgentService` includes `routeQueryOptions(baseOptions, agentDef)` which intercepts queries.
When a named agent carries a `model` binding, it overrides the effective model in query options.
Tool delegation to subagents via the Agent tool similarly resolves each subagent's bound model.

## Dynamic Delegation via MCP Tool

Tier-1 Claude sessions can dynamically delegate sub-work to a cheap/local-backed agent using
an in-process MCP server (`delegation`), implemented with `createSdkMcpServer()` + `tool()`.

- **Gating:** Gated on local-backend availability (`isLocalBackendConfigured()`). If not
  configured or unavailable, the delegation server is omitted from query options.
- **Tools exposed:** `cheap_generate` (single prompts/sub-tasks) and `bulk_summarize`
  (multi-item summaries processed in parallel via `Promise.allSettled`).
- **Routing:** The in-process tool handler executes sub-tasks via `executeLocalProviderQuery()`
  from `providerModels.ts`, keeping routing, formatting, and cost under plugin control.
- **Caching:** The resolved default model ID is cached per base URL. The delegation server
  instance is cached but invalidated when `isLocalBackendConfigured()` returns false.
  Call `clearDelegationCache()` when provider config changes.

`routeQueryOptions()` automatically merges the delegation MCP server into `mcpServers` whenever
the local backend is available.

## Cancellation and timeouts

Both `chat()` and `inlineChat()` use `sendAndWaitWithAbort(fn, options)`:

- Wraps execution with an `AbortController`.
- Optional `timeoutMs` — sets a timer that calls `controller.abort()` on expiry.
- Optional external `signal` — forwarded to the controller.
- On any error (timeout, connection, CLI failure), `controller.abort()` is called before
  rethrowing. A `timedOut` flag distinguishes timeout aborts from user-initiated ones.

`Session.abort()` is used by `synapseView.ts` to cancel in-flight work when a `session.error`
event is received.

## Attachment delivery (issue #77)

`query()`'s `Options` has no top-level `attachments` field (`prompt` is
`string | AsyncIterable<SDKUserMessage>`), so `AgentService`/`Session` do not accept or forward
any `attachments` parameter — there used to be a dead, silently-dropped `attachments?: unknown[]`
param on `Session.send()`/`inlineChat()` and a `MessageOptions`/`buildSdkAttachments()` pair in
`sessionConfig.ts` that targeted a nonexistent SDK shape; both were removed. Callers (the chat
view, editor image actions, the Telegram bot) instead inline attachment paths directly into the
prompt string — see `chat-view.md`'s "Attachment delivery" section for the chat-view mechanism
(`buildPrompt()`, `materializeBlobAttachments()`, `computeAdditionalDirectories()` in
`sessionConfig.ts`).

`Session.send({prompt, additionalDirectories?, timeoutMs?})` accepts an optional
`additionalDirectories` list for a single send() call, merged (deduped) with the session's own
`config.additionalDirectories` from `Options` before being passed to `query()` — this grants the
SDK read access to attachment paths that fall outside the session's `cwd` (out-of-vault absolute
paths, OneDrive-synced folders, or clipboard-blob temp files under `os.tmpdir()`) without
widening what's readable when no such attachment is present in a given turn.

### Adaptive indexing/search timeouts

`getAdaptiveTimeout(app, scopePath, configuredTimeoutSec)` calculates the client-side timeout
dynamically based on the number of files in scope:

- Formula: `Math.max(120_000, Math.min(600_000, 30_000 + fileCount * 200))` (floor 120s, cap 10m)
- The result is compared against `providerRequestTimeout` (settings, seconds → ms) and the
  larger value is used.

## Session management

`AgentService` wraps `listSessions()`, `deleteSession()`, `renameSession()` from the SDK for
the session sidebar. Session history replay uses `session.getEvents()`.

## BYOK local provider injection

When a local provider is configured (Ollama, Foundry Local, or other OpenAI-compatible endpoint),
`buildEnv(forLocalModel = true)` injects the provider base URL and API key into the subprocess
environment (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

This allows the Claude CLI to route through the local endpoint for sessions that use a
locally-backed agent.

## Connection error handling

When `chat()` or `inlineChat()` fails with a connection/network error, the service fires its
`onConnectionError` callback. Detection uses `isConnectionError()` which matches:
`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `EHOSTUNREACH`, `fetch failed`,
`network`, `socket hang up`. Bare `connect` is intentionally excluded to avoid false-positives
on CLI spawn errors.

`main.ts` wires this to an Obsidian `Notice` (8 seconds) pointing the user to check their
local model server or network. The `onConnectionError` callback pattern keeps `AgentService`
free of `obsidian` imports.

## Public API surface

The `providerConfig` fields are private — consumed only internally by `buildEnv()`. Callers
that need provider config (e.g. `buildSessionConfig`) receive it directly from `main.ts`.

## Invariants

- No other module imports `@anthropic-ai/claude-agent-sdk` directly (modals import types only
  — keep type-only imports acceptable, but even those should come via `AgentService` re-exports).
- `AgentService` constructor never throws — errors surface on first query attempt.
- All public methods that invoke `query()` call `resolveCliPath()` first; a missing binary
  is surfaced as an error before any SDK interaction.
- `sendAndWaitWithAbort()` is used for every query — never call `query()` raw.
