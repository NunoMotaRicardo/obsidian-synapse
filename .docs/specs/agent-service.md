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
event is received, and also by the interactive loop turn/token guardrails (see below). It prefers
a graceful `Query.interrupt()` control request over hard-aborting the `AbortController`, falling
back to the latter only when there's no in-flight query or `interrupt()` fails — see "Electron
`.unref()` compatibility (issue #116)" below for why.

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
the session sidebar. Session history replay (cold-loading a session's backlog) uses
`AgentService.getSessionMessages(sessionId)`, which wraps the SDK's `getSessionMessages()` — it
parses the JSONL transcript and returns `SessionMessage[]` (`{type, uuid, session_id, message,
parent_tool_use_id}`) in chronological order. Callers narrow `message` (an Anthropic API message)
and walk its content blocks; `tool_use`/`tool_result` replay is out of scope. The `dir` option is
deliberately **not** passed by the sidebar caller: `listSessions()` (used to populate the
sidebar) is called unscoped across all project directories, and a session's original working
directory can differ from the view's current one (`autoUpdateWorkingDirectory` changes it on note
switch) — passing a mismatched `dir` makes the SDK search only that one project and return `[]`.

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

## Partial message streaming (issue #103)

The interactive chat panel's `SessionConfig` (`SynapseView.buildSessionConfig()`) sets
`includePartialMessages: true`. Only the chat panel does this — `chat()`, `inlineChat()`, and
every unattended caller that goes through them (search, editor text actions, triggers, the
Telegram bot, batch loops) collect full text via `collectText()`/their own accumulation loop and
never read `includePartialMessages`, so they get no extra `stream_event` volume.

When enabled, the CLI additionally emits `SDKPartialAssistantMessage` (`type: 'stream_event'`)
messages carrying one Anthropic Messages API `BetaRawMessageStreamEvent` each
(`message_start`/`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`/
`message_stop`) *before* the turn's complete `assistant` message arrives. `BetaRawMessageStreamEvent`
is re-exported from `agentService.ts` as `SDKPartialAssistantMessage['event']` (not imported
directly from `@anthropic-ai/sdk`) so this module stays the sole point of contact with SDK package
internals.

`Session.convertToSessionEvent()`'s `'stream_event'` case only acts on `content_block_delta`:
`text_delta` → `assistant.message_delta`, `thinking_delta` → `assistant.reasoning_delta`, both with
`{content, deltaContent}` equal to just that chunk's text — these are genuine incremental deltas,
unlike the old behavior described below. `ttft_ms` (present only on the turn's first non-ping
stream event) rides along as an optional `ttftMs` field on whichever delta carries it, rather than
getting a dedicated event type for one optional number.

**No double-render:** the turn's complete `assistant` SDKMessage still arrives after the deltas
(same as before partial streaming existed). `Session` tracks `partialMessagesEnabled` (from
`config.includePartialMessages`) and the `'assistant'` case's per-block loop skips the
`assistant.message_delta`/`assistant.reasoning_delta` redispatch from `text`/`thinking` content
blocks when it's true — those blocks' text already streamed incrementally via `'stream_event'`.
`tool_use` handling (`tool.execution_start`), `assistant.usage`, and the whole-message
`assistant.message` reconciliation dispatch are unaffected and always fire; `assistant.message`
is a no-op on the view side unless the accumulated streamed text actually differs from the
complete message's text (`chat-view.md`'s streaming section), so it never re-renders a second
copy of a turn that streamed correctly.

**Without** `includePartialMessages` (every non-chat-panel caller), the `'assistant'` case's
per-block loop is the *only* source of `assistant.message_delta`/`assistant.reasoning_delta` —
each dispatched once, with the whole finished block's text, exactly as before this issue. This is
still called `_delta` even though it isn't incremental in that mode; `chat-view.md`'s renderer
handles both cases identically (`appendDelta`/`appendReasoningDelta` just accumulate whatever
arrives), so this asymmetry is invisible to consumers.

**Electron `.unref()` compatibility (issue #116):** the Agent SDK's `ProcessTransport.close()`
(`sdk.mjs`) schedules a SIGTERM→SIGKILL escalation timer whenever `close()` runs while the CLI
subprocess is still alive, and calls `.unref()` on it unconditionally. Electron's renderer keeps
the browser/Chromium `setTimeout`, which returns a plain number with no `.unref()` — this throws
`TypeError: setTimeout(...).unref is not a function`.

An earlier version of this fix (landed alongside `includePartialMessages` above, before #116)
patched `globalThis.setTimeout` unconditionally at module load for the plugin's entire lifetime.
That blast radius was rejected: #116 established, by reading the SDK's teardown code and by
empirical testing (several partial-message sends produced zero console errors with no shim
installed at all), that **ordinary query completion never reaches the broken branch** —
`ProcessTransport.readMessages()` always `await`s `waitForExit()` before its generator finishes,
so by the time the SDK's own cleanup calls `transport.close()` the subprocess has already exited
and the escalation branch is skipped. This holds regardless of `includePartialMessages`.

The branch **is** reached when a query is aborted mid-stream: `Session.send()`'s
`AbortController.abort()` synchronously fires an `abort` listener the SDK registers directly on
the controller's signal, which calls `transport.close()` immediately — outside the SDK's own
try/catch — typically while the subprocess is still running. This can throw the `TypeError` twice
per abort: once synchronously (the outer escalation timer), and again roughly 2s later on win32
if the process still hasn't exited by then (a nested SIGKILL timer scheduled from inside that same
callback).

`Session.abort()` now:

1. Prefers `Query.interrupt()` — the SDK's graceful control-protocol stop, which asks the CLI to
   end the current turn and exit through its own normal completion path (the one confirmed safe
   above). No shim involved; this handles the common "user clicked stop" case cleanly.
2. Falls back to hard-aborting `AbortController` only if there is no in-flight query to interrupt,
   or `interrupt()` itself throws (older CLI, unresponsive process). This path forces the kill
   while the subprocess may still be alive, so `agentService.ts` installs a temporary, refcounted
   `setTimeout` shim (`installSetTimeoutShim()`/`uninstallSetTimeoutShim()`) — identical wrapper
   technique as the old module-load version (wraps the numeric id in a `Number` object with no-op
   `unref`/`ref`, still coercing to the same id for `clearTimeout()` via `valueOf()`) — only around
   this call, for `ABORT_SHIM_GRACE_MS` (8s, comfortably past the SDK's own ~7s worst case of
   escalation timers), then restores the original. Refcounted so overlapping aborts across
   sessions don't restore early. `AgentService.stop()` (plugin unload) force-restores immediately
   regardless of the grace-period timer, so the shim never outlives the plugin.

Both paths were verified with the Obsidian dev console: zero `TypeError` on repeated
partial-message sends, zero `TypeError` on mid-stream interrupts via the graceful path, and zero
`TypeError` with `globalThis.setTimeout` confirmed patched-then-restored when `interrupt()` is
forced to fail (exercising the fallback).

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
