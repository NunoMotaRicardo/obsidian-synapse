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
  - `chat()` defaults to a pure text transform (`maxTurns: 1`, `tools: []`, `permissionMode:
    'plan'`).
  - `inlineChat()` defaults to **agentic** behavior: `maxTurns` falls back to
    `DEFAULT_AGENTIC_MAX_TURNS` (50) so multi-step tool use (Read/Glob/Grep loops) can finish.
    Callers doing pure text transforms (editor text actions, note edit/structure, new
    note/canvas/summary) must pass `tools: []` + `maxTurns: 1` explicitly. A `maxTurns: 1`
    default here was the root cause of every tool-using one-shot failing with "Reached maximum
    number of turns (1)".
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
| `systemPrompt` | `{type: 'preset', preset: 'claude_code', append: ...}` for agentic sessions (chat, search, bots, triggers, batch loops); plain strings only for pure text transforms. A plain string **replaces** Claude Code's entire default system prompt, and the model stops using tools — never pass one where tool use is expected. |
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
event is received, and also by the interactive loop turn/token guardrails (see below).

## Run cost reporting (issue #88)

`Session.convertToSessionEvent()` dispatches a new `assistant.run_result` event
(`{totalCostUsd, numTurns}`) whenever an SDK `result` message carries a numeric
`total_cost_usd` — for both success and error results, since an aborted/failed run can still
have accrued cost. Dispatched in addition to (not instead of) the existing `session.error`
mapping for error results.

**Why this can't drive real-time cancellation:** the Agent SDK only reports `total_cost_usd`
(and `num_turns`, `modelUsage`) on the terminal `result` message of a `query()` stream — after
every turn of that run has already executed. By the time `assistant.run_result` fires, there is
nothing left to abort for that run. Real-time, mid-run token counts *are* available (each
`assistant` message's `usage.input_tokens`/`output_tokens`, mapped to `assistant.usage` — see
"Tool execution events" above), which is why the interactive turn/token thresholds
(`chat-view.md`) enforce in real time on turn count and token count, and treat the dollar
threshold as informational-only, checked once `assistant.run_result` arrives. Faking a
per-turn cost estimate to enable "real-time" dollar cancellation was deliberately avoided —
see the invariant below.

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

`Session.send({prompt, additionalDirectories?, timeoutMs?, images?})` accepts an optional
`additionalDirectories` list for a single send() call, merged (deduped) with the session's own
`config.additionalDirectories` from `Options` before being passed to `query()` — this grants the
SDK read access to attachment paths that fall outside the session's `cwd` (out-of-vault absolute
paths, OneDrive-synced folders, or clipboard-blob temp files under `os.tmpdir()`) without
widening what's readable when no such attachment is present in a given turn.

`images` (`Array<{mimeType, base64}>`, issue #79) is only consulted in the local-model branch
(`this.service.isLocalModel(queryOpts.model)`) and passed straight through to
`executeLocalProviderQuery()` — see `chat-view.md`'s "BYOK local provider multimodal delivery"
section for how chat-view populates it and why. `chat()`/`inlineChat()` do not accept or forward
`images` — no caller threads structured attachments through those paths today, so there's no
plumbing to add yet.

### Adaptive indexing/search timeouts

`getAdaptiveTimeout(app, scopePath, configuredTimeoutSec)` calculates the client-side timeout
dynamically based on the number of files in scope:

- Formula: `Math.max(120_000, Math.min(600_000, 30_000 + fileCount * 200))` (floor 120s, cap 10m)
- The result is compared against `providerRequestTimeout` (settings, seconds → ms) and the
  larger value is used.

## Session management

`AgentService` wraps `listSessions()`, `deleteSession()`, `renameSession()` from the SDK for
the session sidebar. Session history replay uses `session.getEvents()`.

A new `Session`'s id is unknown until the first `send()` streams a message. When the wrapper
first captures a `session_id` (also when it changes on resume), it dispatches a
`session.init` event (`{sessionId}`) before any other event of that turn, so the view can adopt
the real id, name the session, and add it to the sidebar. Do not read `Session.sessionId`
right after `createSession()` for a new session — it is `''` at that point.

## Model list mapping

`fetchModels()` maps the CLI's `initializationResult().models` to the plugin `ModelInfo` shape.
`ModelInfo.id` is `sdk.value` verbatim (`'sonnet'`, `'sonnet[1m]'`, `'opus'`,
`'claude-fable-5[1m]'`, …) with `'default'` mapped to `''` (= let the CLI pick). Never derive
ids from `displayName` — labels like "Sonnet (1M context)" or "Fable" do not round-trip to
valid model identifiers.

## Tool execution events (issue #78)

`Session.convertToSessionEvent()` dispatches `tool.execution_start` from `tool_use` content
blocks on `assistant` messages, and `tool.execution_complete` from `tool_result` content blocks
on `user` messages (tool results are delivered as synthetic `user` messages by the SDK, not a
separate event type). A `pendingToolCalls` map (`toolCallId -> toolName`) populated on
`tool.execution_start` lets the matching `tool.execution_complete` event report which tool
produced the result, since `tool_result` blocks only carry `tool_use_id`. `tool.execution_complete`
data: `{toolCallId, toolName, success, result: {content}, error?: {message}}` — `success` is
`!tool_result.is_error`, and `error` is included only when `is_error` is true. `synapseView.ts`
consumes this to render tool-call outcome details and (for Write/Edit/NotebookEdit failures)
surface a friendlier chat message — see `chat-view.md`.

## Plan/task tracking — `TodoWrite` and `TaskCreate`/`TaskUpdate` (issue #87)

Claude Code surfaces its running plan through a tool call rather than a dedicated SDK event —
but the *tool name and payload shape used depend on the CLI version/session*: the SDK's own
`sdk-tools.d.ts` declares both a legacy `TodoWriteInput` (one call carries the entire plan) and a
newer `TaskCreateInput`/`TaskUpdateInput`/`TaskGetInput`/`TaskListInput` family (a task graph
built incrementally, one call per task/patch, with dependency tracking via
`addBlocks`/`addBlockedBy`). **Verified against the installed CLI (2.1.195) during issue #87's
deploy-test: the model used `TaskCreate`/`TaskUpdate` exclusively and never emitted `TodoWrite`**
— so both are supported; `TodoWrite` support is kept for forward/backward CLI compatibility per
the SDK's declared type even though it wasn't observed live. Rather than adding a new
`SessionEvent` variant for either, the view branches on `toolName` in the existing
`tool.execution_start`/`tool.execution_complete` handlers; `AgentService` stays the sole
SDK-access point by owning the *parsing*, not a new event type.

**`TodoWrite`** — `parseTodoWritePayload(input: unknown): TodoItem[] | null` (exported alongside
the `TodoItem` type) normalizes an `input` value into a todo list:

- Returns `null` when `input` doesn't look like a `TodoWrite` payload at all (not an object, or
  no `todos` array) — callers fall back to generic tool-call rendering for that case.
- Returns `[]` for a valid-shaped but empty todo list (a legitimate "plan cleared" state).
- Parsed defensively, not schema-validated: the exact `{todos: [{content, status, activeForm?}]}`
  shape mirrors the SDK's `TodoWriteInput` type but isn't re-validated against it (a hand-rolled
  mirror can still drift across CLI versions). Each todo entry needs a non-empty string
  `content`; `status` falls back to `'pending'` for any missing/unrecognized value (only
  `'in_progress'` and `'completed'` are recognized otherwise); `activeForm` (the present-tense
  form shown while a task is in progress, e.g. "Running tests") is included only when present as
  a non-empty string. Non-object entries in `todos` are skipped.

**`TaskCreate`/`TaskUpdate`** — no single call carries the full plan, so the view accumulates a
`TaskPlan` (`Map<string, TodoItem>`, keyed by the server-assigned task id) across calls in a
turn:

- `parseTaskCreateInput(input): {subject, activeForm?} | null` parses the fields available at
  call time — the id isn't known yet (it's server-assigned and only appears in the result), so
  the view stashes the parsed fields keyed by `toolCallId` (a `pendingTaskCreates` map) until the
  matching `tool.execution_complete` arrives.
- `parseTaskCreateResultId(resultText): string | null` extracts the id from the `TaskCreate`
  result's flattened text content. The CLI's `TaskCreateOutput` type is structured
  (`{task: {id, subject}}`), but `tool_result` content already arrives at the view as plain text
  (`convertToSessionEvent()` flattens it) — observed format:
  `"Task #<id> created successfully: <subject>"`. On a successful `TaskCreate` completion with a
  parseable id, the view adds `{content: subject, status: 'pending', activeForm}` to `TaskPlan`.
- `parseTaskUpdateInput(input): {taskId, status?, subject?, activeForm?} | null` parses a patch;
  `status` additionally recognizes `'deleted'` (not a valid `TodoItem` status — the view removes
  the entry from `TaskPlan` instead of rendering a fourth status). Dependency fields
  (`addBlocks`/`addBlockedBy`) aren't part of the return value — the panel tracks status, not the
  dependency graph. The view only applies an update if `taskId` already exists in `TaskPlan`
  (ignores updates to unknown/untracked ids rather than fabricating a placeholder entry).

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
- No fabricated cost estimates: dollar cost is only ever reported when the SDK itself provides
  `total_cost_usd` (the terminal `result` message). No per-turn/per-token cost approximation is
  computed or displayed anywhere in the plugin.
