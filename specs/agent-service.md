# agent-service

Source: `src/agentService.ts` — class `AgentService`. The single place the plugin touches
`@anthropic-ai/claude-agent-sdk`. Every other module goes through this wrapper.

> **Module naming:** The spec filename is `agent-service.md`. The live class and all code references use `AgentService`.

## Responsibilities

- Build query options (`pathToClaudeCodeExecutable`, `env`, `model`, `plugins`, `skills`, etc.)
  and invoke `query()` from the Agent SDK.
- Manage session list/delete/rename via `listSessions()`, `deleteSession()`, `renameSession()`.
- One-shot helpers: `chat()` (ephemeral, no session) and `inlineChat()` (persisted session)
  used by editor actions, search, batch loops, and bots.
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
| `systemPrompt` | `{type: 'preset', preset: 'claude_code', append: ...}` for agentic sessions (chat, search, bots, batch loops); plain strings only for pure text transforms. A plain string **replaces** Claude Code's entire default system prompt, and the model stops using tools — never pass one where tool use is expected. |
| `plugins` | `_synapse/` vault folder registered as local SDK plugin (`{type: 'local', path: ...}`) |
| `skills` | enabled skill names array from toolbar |
| `canUseTool` | tool-approval modal or `approveAll` |
| `onElicitation` | elicitation modal |
| `mcpServers` | delegation MCP server when local backend is available |

## CLI resolution

`AgentService.resolveCliPath()` returns a `ResolvedCliPath`:

1. If `claudeLocation` is set in settings, use it as-is (`source: 'settings'`).
2. Otherwise, call `resolveDefaultCliPath()` from `runtimeManager.ts` which walks the chain:
   global npm → OS links (WinGet, `~/.claude/bin/`) → SDK fallback.

Either way, `fs.access(resolved.path)` is called (in `ensureConnected()`, ahead of every query) to
surface a clear "binary not found" error before attempting to spawn.

On first resolution, `getCliVersion(resolved.path)` is called fire-and-forget (try/catch — must
not block). On success, the `onVersionInfo` constructor callback (`VersionInfoCallback`) is fired
with `{version, path}`. `main.ts` wires this to a console log; the settings UI
reads `getVersionInfo()` to display the resolved binary path, source, and version.

## Auth model

Dual auth via `buildEnv()`:

- **Subscription (OAuth):** The `claude` CLI manages its own OAuth login. No `ANTHROPIC_API_KEY`
  is set; the CLI picks up the stored credential automatically.
- **API key:** `ANTHROPIC_API_KEY` is injected into the subprocess env from `auth.apiKey`.

## Session-scoped permission updates (issue #193)

`sessionScopePermissions(suggestions: PermissionUpdate[]): PermissionUpdate[]` maps each CLI-
suggested `PermissionUpdate` to `{...u, destination: 'session'}`. Every variant of the SDK's
`PermissionUpdate` union carries `destination` (`'userSettings' | 'projectSettings' |
'localSettings' | 'session' | 'cliArg'`), so the spread is type-safe with no per-variant switch.

The CLI's `canUseTool` suggestions are not safe to echo back unfiltered: for directory-shaped
grants (e.g. approving a read on an out-of-vault attached folder) the CLI suggests
`'localSettings'`, which the SDK writes to `<cwd>/.claude/settings.local.json` — inside the vault,
for chat sessions — including blanket, drive-wide grants such as `Read(//d//**)`. Forcing
`'session'` keeps the approval in effect only for the rest of the current conversation (so the
user isn't re-prompted for the same path) without ever persisting a rule to disk.

`ToolApprovalModal`'s **Allow** and **Always allow** buttons (`src/modals/toolApprovalModal.ts`)
are the sole callers — both reach `sessionScopePermissions()` and the `PermissionUpdate` type through this module's
re-exports rather than importing the SDK directly. See `chat-view.md`'s "Tool approval never
persists to disk" section for how `SynapseView.buildSessionConfig()`'s `permissionHandler` uses
this (and why its auto-allow branch sends no `updatedPermissions` at all instead). A deliberate
*persistent* grant is a separate mechanism, added later (issue #197): the modal's **Always allow**
button calls `persistToolApprovalRules()` (`src/configWriter.ts`), which writes the same rule
string(s) `permissionRuleToString()`/`extractAllowRuleStrings()` (below) derive directly into
`_synapse/settings.json`'s `permissions.allow` — the vault settings layer described below.
#194 (below) reads and merges that file; nothing in `agentService.ts` ever writes to it.

### In-memory tool-approval grants across the per-`send()` respawn (issue #193 round 2)

`destination: 'session'` above only covers the **current CLI process**. The Agent SDK spawns a
fresh `claude` process on every `Session.send()` call (resuming by session id, not by keeping a
process alive) — see "Agent SDK model" below. That respawn does not inherit the previous
process's session-scoped grant, so in **ask** mode a user approving an out-of-vault read was
re-prompted for the identical path on every subsequent turn of the same conversation.

The fix carries approved grants **in memory**, for the life of the conversation, and re-injects
them into every query rather than relying on the CLI's own process-local state:

- `extractAllowRuleStrings(suggestions: PermissionUpdate[]): string[]` converts only `addRules`
  updates with `behavior: 'allow'` into rule strings (`permissionRuleToString()`: `toolName`
  alone, or `toolName(ruleContent)` — the same syntax the CLI itself writes to
  `settings.local.json`). Every other update type (`replaceRules`, `removeRules`, `setMode`,
  `addDirectories`, `removeDirectories`) and any non-`'allow'` behavior is skipped — there is no
  faithful way to represent "replace" or "remove" semantics against a purely additive in-memory
  accumulator.
- `buildInMemoryPermissionSettings(grants, existing?): Options['settings']` builds the inline
  `{permissions: {allow: [...]}}` object the SDK loads into its highest-priority user-controlled
  "flag settings" layer (`Options.settings`, equivalent to the CLI's `--settings` flag) — merging
  with a pre-existing object `settings` value rather than clobbering it (no caller sets one today,
  but a future one might). A pre-existing *string* `settings` (a file path) is left untouched,
  since folding an in-memory list into a file on disk would mean writing to it — exactly what this
  feature must never do.
- `Session.applyToolGrants(grants)` merges the grants into the live `Session`'s config in place
  (via `buildInMemoryPermissionSettings()`, against that session's own `settings` — the merge lives
  here because `config` is private, so a caller could only pass a grants-only object and would drop
  anything else the session was built with), so a grant added
  mid-conversation reaches the *next* `send()` on the same (un-rebuilt) `Session` object — `send()`
  always reads `this.config` fresh on each call.

The accumulator itself (`SynapseView.sessionToolGrants`) and the call sites that populate/consume
it live in the view layer — see `chat-view.md`'s "In-memory tool-approval grants" for where the
set lives, how it survives a `configDirty` `Session` rebuild, and when it's cleared. Nothing here
is ever written to disk; the grants die with the conversation. #194's vault settings layer (below)
merges *underneath* whatever this produces — see "Vault settings layer (issue #194)" — rather than
adding a second, separate merge point.

## Vault settings layer (issue #194)

`_synapse/settings.json` is the vault's own settings layer — vault-scoped configuration that
follows the vault regardless of a session's `cwd` (unlike the pre-#193 behavior of whatever the
CLI persisted into `<cwd>/.claude/settings.local.json`, which changed meaning when `cwd` was
scoped to a subfolder, and #193 stopped persisting to entirely). It sits alongside `agents/*.md`,
`skills/*/SKILL.md`, and `.mcp.json` as vault-local customization (`wiki/Customization.md`), but
is applied inside `AgentService`, not written by the plugin.

**Applied at a single choke point, not threaded through every caller.** All three real query
paths — `chat()`, `inlineChat()`, and `Session.send()` (via `AgentService.createQuery()`) — funnel
through the private `routeQueryOptions(options, app?)`, which already resolves the bound model and
merges the delegation MCP server. The vault settings layer is merged there too, so none of the ~7
call sites that build `Options` (`chat-view.md`'s `buildSessionConfig()`, `runExecutor.ts`,
`editorMenu.ts`, `editModal.ts`, `searchPanel.ts` x2, `telegramBot.ts`) needed to change their own
settings-building logic — they only needed to pass the `App` handle they already have (see
"Caller wiring" below).

**Read as a parsed object, never the path-string form.** `Options.settings` accepts `string |
Settings`; `AgentService` always resolves to the object form. This is deliberate, not incidental:
`buildInMemoryPermissionSettings(grants, existing)` (#193 round 2, above) treats a *string*
`existing` as an untouched passthrough — folding an in-memory grant list into an arbitrary file
path would mean writing to it, which that feature must never do. Passing the vault layer as a
path string would silently defeat that merge (session grants would vanish into the ignored-string
branch) the moment a caller's `settings` became a path. Reading and parsing the file plugin-side
keeps everything on the object-merge branch.

- **`getSynapseSettingsPath(app): string`** (`vaultPaths.ts`) derives `<basePath>/_synapse/settings.json`
  — pure path derivation, no fs access, matching `getSynapsePluginConfig()`'s existing pattern.
  `vaultPaths.ts` stays dependency-free (no `node:fs`, no internal imports) per its own spec.
- **`AgentService.loadVaultSettings(app): Settings | undefined`** does the actual read: a
  synchronous `fs.statSync`/`fs.readFileSync`/`JSON.parse` (desktop-only plugin, tiny file — a
  sync read keeps `routeQueryOptions()`, which every query passes through, synchronous). Cached
  per-instance by `{path, mtimeMs}` (`vaultSettingsCache`) so an edit to the file is picked up on
  the very next query (AC-5) without re-parsing an unchanged file on every turn. `fs` is imported
  statically (`import * as fs from 'node:fs'`) rather than through the lazy `window.require` gate
  used elsewhere in this file for `node:fs/promises` — that gate exists for a one-time async
  fallback off the hot path (`ensureConnected()`); this method runs on every query build and must
  stay synchronous, and a static import also works in the test environment where
  `window.require` is unavailable. (Mirrors the now-removed `mcpBridge.ts`'s `_synapse/.mcp.json`
  read — issue #220 deleted that module, but the SDK still reads `.mcp.json` natively.)
  - **Absent file → `undefined`, silently** (AC-2): a missing `_synapse/settings.json` behaves
    exactly as before this issue. The plugin never creates the file itself.
  - **Malformed JSON → `undefined`, with exactly one `[synapse]`-prefixed `Notice` + `debugTrace`**
    (AC-4): the query proceeds without the layer rather than crashing. A second `Map` keyed by
    path (`malformedSettingsWarnedAt: Map<string, number>`) tracks the mtime of the last warning,
    so repeated queries against the same broken file warn once, not once per turn; a new mtime
    (the user edited the file, whether fixed or re-broken) clears the dedup and allows one more.
- **`mergeVaultSettingsLayer(vaultSettings, existing?): Options['settings']`** (exported, pure)
  merges the vault object underneath whatever `Options.settings` the caller/session already
  carries. `vaultSettings` is always the base; `existing` is layered on top:
  - `permissions.allow`/`deny`/`ask` are **unioned**, not one side replacing the other — this is
    what makes AC-3 hold: a session's in-memory tool-approval grant
    (`Session.applyToolGrants()` -> `buildInMemoryPermissionSettings()`, folded into
    `this.config.settings` before `send()` ever reaches `routeQueryOptions()`) only ever *adds*
    to `permissions.allow`, so unioning both sides means the vault's own `deny`/`ask` rules
    survive that merge instead of being dropped by it.
  - Every other top-level key prefers `existing`'s value when both sides set it (plain object
    spread, `existing` last) — a caller's/session's explicit setting wins on conflict, per the
    issue's decision.
  - If `existing` is a settings *file path* rather than an object, it's returned unchanged — same
    defensive convention as `buildInMemoryPermissionSettings()`'s `existing` handling, for the
    same reason (no way to fold an object into an arbitrary path without writing to it). No
    caller in this codebase sets a string `Options.settings` today.

**Caller wiring.** `routeQueryOptions(options, app?)` only applies the layer when `app` is
present — `AgentService` holds no `App` reference of its own (architecture rule: SDK/session
plumbing stays UI-agnostic), so every caller passes its own handle:

- `chat()` gained an `app?: App` option (it had none before this issue) — unused for anything
  else (no vault tools offered by this one-shot helper).
- `inlineChat()`/`Session.send()` already had `app?: App` (originally added for #150/#138's
  since-removed local-model vault-tool gate — see "Local models" below); it's now *also* read on
  the real Agent SDK path (previously ignored there). `SynapseView` already passed
  `app: this.app` unconditionally on every `Session.send()` call, and `searchPanel.ts`'s two
  `inlineChat()` calls already passed `app: this.app` (#167) — no change needed for the chat
  panel or search. `editorMenu.ts` (9 call sites), `editModal.ts`, `telegramBot.ts`, and
  `runExecutor.ts`'s `executeWithClaude()` (batch loops/runs) did not previously pass `app` to
  `inlineChat()` and were updated to pass it, purely to make the vault path derivable — none of
  their own settings-building logic changed.
- Passing `app` alone does not by itself grant tool access — a caller must also supply
  `canUseTool` (see "Wiring `inlineChat()`'s callers" under "Local models" below); every site
  updated here still omits `canUseTool`, so no new tool access opened up as a side effect of this
  change, per #167's `editorMenu.ts` tests.

**`settingSources` default (issue #196).** `routeQueryOptions()` also defaults
`Options.settingSources` to `['user', 'project']` when a caller hasn't set one, dropping the Agent
SDK's own default of `['user', 'project', 'local']`:

- **`'local'` is dropped.** It maps to `<cwd>/.claude/settings.local.json` — a file this plugin no
  longer writes (#193) but that can still exist and silently apply if `cwd` happens to contain one
  (including stale drive-wide grants #193 used to write there before that fix). Dropping it closes
  that leak without adding a settings toggle: the plugin never reads or writes
  `.claude/settings.local.json` itself, so there is nothing for a user to configure.
- **`'project'` is kept** so a vault-root `.claude/settings.json` and any vault `CLAUDE.md` still
  load — the Agent SDK requires `'project'` in `settingSources` for `CLAUDE.md` to be picked up at
  all. Nothing in `src/` depends on this today, but a vault owner may have one.
- **`'user'` is kept** so the user's global `~/.claude/settings.json` keeps applying exactly as it
  does today.
- **A caller-set `settingSources` always wins** — the default only fills in when `options.settingSources`
  is unset, same "caller's explicit value wins" convention as the rest of `routeQueryOptions()`.
- This is orthogonal to the vault-settings layer above: `_synapse/settings.json` is read and merged
  by the plugin directly into `Options.settings` (the higher-priority flag-settings layer, per the
  SDK's own precedence), never through `settingSources`/`SettingSource` — so this default has no
  effect on whether `_synapse/settings.json` applies.

## Named Agent Model Binding & Routing

Named agents parsed from `_synapse/agents/*.md` (`configWriter.ts`'s `scanAgents()`, into
`AgentConfig[]`) carry an optional `model` binding (Claude model alias or local backend model ID).

This resolution does not happen inside `AgentService`. `resolveModelForAgent(agent, models,
fallback)` (`view/sessionConfig.ts`) matches the agent's `model` string against the available
`ModelInfo[]` (exact id/name/`resolvedModel` match, then substring, then a `haiku`/`sonnet`/
`opus`/`flash`/`pro` keyword fallback — the same tiers `AgentService#resolveValidModel` uses, see
"Model list mapping" above) and falls back to the caller-supplied default when nothing matches.
Callers resolve the model this way *before* building `Options` — `configToolbar.ts`,
`synapseView.ts`, `searchPanel.ts`, and `telegramBot.ts` all call it directly — so by the time
`AgentService.routeQueryOptions(options, app?)` (private; see "Vault settings layer" above) runs,
`options.model` is already the resolved id. `routeQueryOptions()` takes no `agentDef` parameter.

## Dynamic Delegation via MCP Tool

Tier-1 Claude sessions can dynamically delegate sub-work to a cheap/local-backed agent using
an in-process MCP server (`delegation`), implemented with `createSdkMcpServer()` + `tool()`.

- **Gating:** Gated on `isLocalAgentEndpointConfigured()`. If no local agent endpoint (issue
  #122, see "Local models" below) is configured, the delegation server is omitted from query
  options.
- **Tools exposed:** `cheap_generate` (single prompts/sub-tasks) and `bulk_summarize`
  (multi-item summaries processed in parallel via `Promise.allSettled`).
- **Routing:** the tool handler resolves the endpoint's default model
  (`resolveEndpointDefaultModel()`, the first entry of `fetchEndpointModels()`'s catalogue) and
  delegates via `chat()` — the same real-Agent-SDK path a direct local-model chat query takes.
  Post-#220 there is no other execution path to fall back to.
- **Caching:** the resolved default model ID is cached per base URL. The delegation server
  instance is cached but invalidated when `isLocalAgentEndpointConfigured()` returns false.
  Call `clearDelegationCache()` when the endpoint config changes.

`routeQueryOptions()` automatically merges the delegation MCP server into `mcpServers` whenever
the local agent endpoint is configured.

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

## Compaction event mapping (issue #177)

`Session.convertToSessionEvent()` converts SDK `compact_boundary` system messages
(`SDKCompactBoundaryMessage`) into `session.compaction_complete` events carrying:
- `preCompactionTokens: compact_metadata.pre_tokens`
- `postCompactionTokens: compact_metadata.post_tokens` (optional in the SDK)
- `durationMs: compact_metadata.duration_ms` (optional in the SDK)
- `trigger: compact_metadata.trigger` (`'manual' | 'auto'`)

The SDK emits `compact_boundary` only upon reaching the compaction boundary; there is no
corresponding "compaction starting" signal from the SDK, so `session.compaction_start` is not
dispatched. There is also no failure payload: the SDK only ever emits this message on success,
so the event carries no success/failure flag. If a failure signal is ever added to the SDK, the
event should gain a field for it then rather than carrying a permanently-true one now.

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

There is no `images` parameter anymore (issue #79's `Array<{mimeType, base64}>` payload, and the
local-model branch that consulted it, were removed by #220 — see "Local models" below): every
model, Claude or local, reads image attachments via the agentic `Read` tool on an inlined path,
same as the rest of `chat-view.md`'s "Attachment delivery" mechanism above.

### Adaptive indexing/search timeouts

`getAdaptiveTimeout(app, scopePath, configuredTimeoutSec)` (`view/sessionConfig.ts`, not
`agentService.ts`) calculates the client-side timeout dynamically based on the number of files in
scope:

- Formula: `Math.max(120_000, Math.min(600_000, 30_000 + fileCount * 200))` (floor 120s, cap 10m)
- The result is compared against `providerRequestTimeout` (settings, seconds → ms) and the
  larger value is used.

## Session event map (issue #179)

`Session.dispatch()`/`Session.on()`, and `AgentService.createSession()`'s `onEvent` callback, are
generic over `SessionEvents` — a `Record`-like interface mapping each dispatched event name (the
exact string literals `Session.convertToSessionEvent()` and `Session.send()` use) to its payload
type:

```ts
dispatch<K extends keyof SessionEvents>(type: K, data: SessionEvents[K]): void;
on<K extends keyof SessionEvents>(type: K, handler: (data: SessionEvents[K]) => void): () => void;
```

An event name not in `SessionEvents`, or a payload that doesn't match the declared shape for that
name, is a **compile error** at both the dispatch site and every `on()` call site — the compiler
now owns the contract `test/sessionEventWiring.test.ts` used to guard by reading source text.
That test is deleted as of this change (superseded, not just redundant — a source-text regex
can't see a type error). Each payload type was derived from what the producer actually sends and
what the consumer(s) actually read, not from what might be useful later; see `SessionEvents`'
doc comment in `agentService.ts` for the full list.

Two things fell out of writing the map against the real producers/consumers:

- **`assistant.reasoning` was a dead event type.** Both registration sites (`synapseView.ts`'s
  `registerSessionEvents()` and `sessionSidebar.ts`'s `registerBackgroundEvents()`) subscribed to
  it, but nothing ever dispatched it — `assistant.reasoning_delta` (a different, live event) was
  the only reasoning-related dispatch. It predates this change and was harmless (the equivalent
  reconciliation happens via `assistant.message`), but a typed map has no "unreachable key" to
  register for, so it's removed from `SessionEvents` and both registration sites.
- **`assistant.message`'s payload never carried `reasoningText`.** Both view-side handlers read
  `data.reasoningText` defensively, but no producer in `agentService.ts` ever sets it — the
  dispatch is always `{content}`. Removed from both handlers along with the field.

**Partial registration is intentional, not a gap to close.** `SessionEvents` describes every
event a `Session` can dispatch; a given `session.on(...)` call site is free to subscribe to a
subset (`registerBackgroundEvents()` deliberately omits `session.init`, `assistant.run_result`,
`session.compaction_complete`, and `session.metadata` — see "Query metadata cache" below for how
`session.metadata`'s omission there is compensated). `on()` is not exhaustiveness-checked against
`SessionEvents`, and should not become so.

The wrapped `{type, data}` shape (still exported as `SessionEvent`, now a discriminated union
over `SessionEvents`) survives only where a single callback must handle every event
type-erased — `AgentService.createSession()`'s `onEvent` parameter, and the early-event buffer /
`handleSessionEvent()` dispatcher in `synapseView.ts` that both the buffer replay and the typed
`session.on(...)` registrations feed into via a small per-key `forward()` wrapper. A handler
registered directly via `Session.on()` never sees the wrapper — it gets `data` alone, typed to
that one event's payload, with no cast at the call site.

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

### Carrying a conversation across a rebuilt Session (issue #104)

The SDK has no long-lived `Query` to mutate mid-conversation — `Session.send()` creates a fresh
`query()` per turn (with `resume: <sessionId>` when known) and clears its `Query` handle in a
`finally` once the turn ends. Because of that, model/permission-mode/reasoning-effort changes
already take effect on the next turn simply by living in `this.config`; there is nothing to call
mid-session (no `Query.setModel()`/`setPermissionMode()` — there's no live `Query` between turns
for those to act on).

That also means a brand-new `Session` object always starts with `_sessionId = ''` and has no
seeding path other than its config — `sessionId` is a read-only getter. `synapseView.ts`'s
`ensureSession()` tears down and rebuilds the `Session` whenever `configDirty` is set (any
toolbar config change); without carrying the outgoing session's id forward, the rebuilt
`Session`'s first `send()` would omit `resume` and silently start a brand-new CLI conversation.

`ensureSession()` fixes this by reading `currentSession.sessionId` **before** tearing the old
session down, then passing it as `buildSessionConfig(opts.resume)` into the rebuilt
`SessionConfig`. `Session.send()` resolves the effective `resume` id via
`resolveResumeSessionId(sessionId, configResume)`: the session's own captured `_sessionId` wins
once it has one (set from the first message of *this* `Session` object); otherwise the
config-seeded id — the prior `Session`'s id, carried across the rebuild — is used. Exported and
unit-tested (`test/sessionResume.test.ts`) since it requires no live CLI to verify.

## Model list mapping

`fetchModels()` maps the CLI's `initializationResult().models` to the plugin `ModelInfo` shape via
`mapSdkModel()`. `ModelInfo.id` is `sdk.value` verbatim (`'sonnet'`, `'sonnet[1m]'`, `'opus'`,
`'claude-fable-5[1m]'`, …) with `'default'` mapped to `''` (= let the CLI pick). Never derive
ids from `displayName` — labels like "Sonnet (1M context)" or "Fable" do not round-trip to
valid model identifiers.

`mapSdkModel()` only carries over fields the SDK's `ModelInfo` actually publishes — `resolvedModel`,
`description`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`, plus
`capabilities.supports.reasoningEffort`/`capabilities.supportedReasoningEfforts` derived from
`supportsEffort`/`supportedEffortLevels`.
It used to also stamp every model with a hardcoded `limits: {max_context_window_tokens: 200000}`
(wrong for 1M-context variants, and unread by any consumer) and a blanket `vision: true`/
`tools: true` (invented — the SDK's `ModelInfo` has no vision or tool-support field at all). Both
are gone (#105); absent beats wrong. Consumers that read `supportsTools` already treat absence as
"assume supported" (`runExecutor.ts`: `modelInfo?.supportsTools !== false`), so Claude models
keep working exactly as before. `ModelInfo.capabilities.limits` stays typed as an open
`Record<string, unknown>` bag (not currently populated for Claude models) rather than removed
outright, because `synapseView.ts` reads a `limits['vision'].max_prompt_images` shape that some
future provider mapping may populate — only the dead `max_context_window_tokens` key is gone.
`isVision`/`supportsTools`/`capabilities.supports.vision`/`capabilities.supports.tools` remain part
of the `ModelInfo` shape (local providers in `providerModels.ts` still populate them from real
heuristics/`/api/show` capability lists) — `mapSdkModel()` just no longer sets them.

`resolvedModel` (the canonical wire id an alias row resolves to, e.g. `'sonnet'` ->
`'claude-sonnet-5'`) is used as an additional exact-match tier in `AgentService#resolveValidModel`
and `resolveModelForAgent` (`view/sessionConfig.ts`), ahead of their existing substring/keyword
heuristics: a persisted explicit/canonical id now matches its alias row deterministically instead
of only via the substring fallback (`target.includes(m.id)`) that already coincidentally caught
most such cases. The substring and keyword-list (`haiku`/`sonnet`/`opus`/`flash`/`pro`) tiers stay,
unchanged, because `resolvedModel` is only ever set on SDK-sourced (Claude) rows — local-provider
rows from `customModels` never have it, and the keyword tier still does useful work for
non-Claude/partial-name matches.

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
every unattended caller that goes through them (search, editor text actions, the
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

**`userInterruptRequested`:** unlike a hard `AbortController.abort()` — which the SDK always
surfaces to `send()`'s `for await` loop as a clean `AbortError` — a graceful `Query.interrupt()`
doesn't guarantee the interrupted turn ends silently; the CLI can end it with a thrown "error
result" (`Claude Code returned an error result`) instead. Session tracks
`userInterruptRequested` (set when `abort()`'s `interrupt()` call resolves, cleared at the start/end
of each `send()`) so that case is treated the same as `AbortError` in `send()`'s catch — an
expected, user-initiated stop, not a `session.error` to dispatch or rethrow. Verified: interrupting
mid-stream no longer surfaces a `[synapse] Send error` console message or an in-chat error bubble.

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

## Local models (issue #220 — provider matrix and local ReAct loop removed)

Local models — Ollama or another Anthropic Messages-API-speaking endpoint — run through the
**same real Agent SDK/CLI as Claude models**, not a separate execution path. There is no
provider preset, no OpenAI-compatible `/v1/chat/completions` loop, and no local-model-only
branch left in `chat()`/`inlineChat()`/`Session.send()`. See
`.docs/decisions/2026-09-09-anthropic-only-provider-and-batch-loop-removal.md` for the removal
decision and history; the historical design of the removed matrix/loop (issues #79, #117–#120,
#129, #135, #137, #138, #150) lives in git history and that decision doc, not here.

- **`AgentService.isLocalAgentEndpointConfigured(): boolean`** — true when a non-empty
  `LocalAgentEndpointConfig.baseUrl` was supplied to the constructor (settings:
  `Claude → Local agent endpoint`). Independent of `AuthConfig`/`authType` (used only for Claude
  models).
- **`isLocalModel(modelId?: string): boolean`** decides per-model whether a query routes through
  the endpoint. Checked in order: an id `sdkModels` reports as SDK-known → `false`; a
  `/^claude-/i`-shaped id → `false` (protects a genuine Claude id even before a `fetchModels()`
  call has populated `sdkModels`, since real SDK ids are always `claude-*`); `customModels`
  membership (populated from `fetchEndpointModels()`'s `/v1/models` catalogue,
  `setCustomModels()`) → `true`; otherwise, when the endpoint is configured, an unknown id also
  → `true` (the CLI surfaces a bad id as a query error) — `false` when no endpoint is configured
  (nothing local exists to serve it). The SDK-known/Claude-shaped checks run first so an
  endpoint's catalogue can never misroute a genuine Claude id away from its real auth, regardless
  of what that catalogue happens to contain (e.g. an aggregator echoing `claude-*`-shaped ids).
- **`buildEnv(modelId?)`**: when `modelId` is classified local (`isLocalModel()`) *and* the
  endpoint is configured, sets `ANTHROPIC_BASE_URL` to the endpoint's base URL and
  `ANTHROPIC_API_KEY` to its configured key (falling back to the literal `'ollama'` when blank,
  per Ollama's own docs) for that call only — additive to, not a replacement of, the
  subscription/API-key auth branches, which run unchanged for every Claude-model call and for
  local-model calls when no endpoint is configured. Every call site that builds `env` threads its
  own `model`/`queryOptions.model` through to `buildEnv()` for this reason (`chat()`,
  `inlineChat()`, `createQuery()`).
- **`routeQueryOptions()`** preserves a local model's requested id (rather than clearing it, the
  way an unresolvable Claude id would be) so it reaches the endpoint as the CLI's `model` request
  field.
- **Model discovery**: `fetchEndpointModels({baseUrl, apiKey})` (`providerModels.ts`) — ONE
  `requestUrl` GET to `<baseUrl>/v1/models`, mapping the OpenAI-shaped `{data: [{id, ...}]}`
  catalogue to `ModelInfo[]`. `main.ts#initAgentService()` calls it whenever
  `localAgentEndpointUrl` is set, backing `setCustomModels()`/the model picker. There is no
  per-model capability catalogue anymore — an unknown model defaults tool-capable per issue
  #129's unknown≠unsupported rule (the SDK path never gated on it).
- **Delegation tools** (`cheap_generate`/`bulk_summarize`, "Dynamic Delegation via MCP Tool"
  above): resolve their default model from `fetchEndpointModels()`'s first catalogue entry
  (`resolveEndpointDefaultModel()`, cached per `baseUrl` and invalidated by
  `clearDelegationCache()`) and run through `AgentService.chat()`, same as everything else —
  there is no separate local-provider execution path for them to fall back to.
- **Settings-side verification (issue #223)**: the settings section has a **Test** button that
  probes `<baseUrl>/v1/messages` directly with `testLocalAgentEndpoint()` (`providerModels.ts`)
  — no CLI spawn — so an endpoint that doesn't speak the Messages API is caught at configuration
  time; see [settings.md](settings.md)'s "Local agent endpoint Test button (issue #223)".
- **Continuity and images**: since every model runs through the CLI with `resume` and the
  agentic `Read` tool, the Agent SDK path alone owns conversation continuity and image delivery
  for all models — there is no separate history-bridging or image-bytes mechanism left
  (`buildLocalHistory()`, `computeSdkHistoryGap()`/`buildSdkHistoryInjection()`, and
  `SynapseView.handleSend()`'s local-model image resolution were all removed by #220).
- **Tool approval**: a local-model query is gated by the exact same `canUseTool`/
  `resolveToolApprovalPolicy()` machinery as a Claude-model query (see "Session-scoped
  permission updates" above and `run-executor.md`'s "Tool approval policy") — there is no
  separate local-path approval adapter anymore (`adaptCanUseToolToLocalApproval()` and
  `LocalToolApprovalHandler` were removed along with `executeLocalProviderQuery()`).
  `autoApproveReadOnlyTools`'s `READ_ONLY_TOOL_NAMES` is now `Read`/`Glob`/`Grep` only — the
  local-path analogues (`read_note`/`list_notes`/`search_notes`, `vaultTools.ts`) no longer
  exist; see "Wiring `inlineChat()`'s callers" below, which otherwise still applies unchanged.
- **Security note (settings UI copy, per the repo's network-access convention)**: a
  user-supplied endpoint URL redirects the *entire* agent loop for that query, including tool
  calls, to whatever is listening there — the settings UI explicitly says so and recommends only
  pointing it at a trusted endpoint (loopback Ollama by default).

### Wiring `inlineChat()`'s callers (issue #167)

Of `inlineChat()`'s call sites, only two genuinely request tools on the SDK path:
`searchPanel.ts`'s basic and advanced search (`tools: ['Read', 'Glob', 'Grep']`, `maxTurns: 40`).
The rest pass `tools: []` deliberately — one-shot generation actions (create note, create canvas,
edit selection) that have no tools — and are untouched.

**Resolution: `autoApproveReadOnlyTools`, a dedicated read-only-only `CanUseTool`** — not a new
"attended-but-automated" permission concept, and not #151's `resolveToolApprovalPolicy()` either:

- It is **not** #151's policy (`src/runExecutor.ts`, "Tool approval policy" — governs
  `batchLoopExecutor.ts`'s unattended runs via `runExecutor.ts`, where `'ask'` means "no human to
  ask, so deny" because those runs may request write-capable tools). `autoApproveReadOnlyTools`
  is attended (a human clicked "Search"), and every call site wiring it in restricts `tools` to
  the read-only set — the two contexts differ on both axes (attended vs. unattended, read-only
  vs. write-capable) and are kept as two separate mechanisms rather than unified.
- A verified spike against the live CLI showed the Agent SDK path *never invokes* `canUseTool`
  for `Read`/`Glob`/`Grep` at all — the CLI auto-approves them before the callback would even
  fire — while a write tool (`Write`) still goes through `canUseTool` and is denied when there's
  no attended handler. `autoApproveReadOnlyTools` reproduces the CLI's own shipped behavior for
  these tools rather than inventing a laxer policy next to it.
- `autoApproveReadOnlyTools` (`agentService.ts`, exported) is a `CanUseTool` that allows a tool
  only if its name is in `READ_ONLY_TOOL_NAMES` (`Read`/`Glob`/`Grep`) and **denies anything
  else**. The check is in the handler rather than left to the caller on purpose: `inlineChat()`
  forwards the same `canUseTool` to the raw `query()` call too (it is a single option, not two),
  so an unconditional always-allow handler would silently grant writes at any future call site
  that wired it in alongside a write-capable tool. Call sites that legitimately need
  write-capable tools use #151's `resolveToolApprovalPolicy()` instead.
- Wired into `searchPanel.ts`'s `handleBasicSearch()`/`handleAdvancedSearch()`: both pass
  `app: this.app, canUseTool: autoApproveReadOnlyTools` alongside their existing
  `tools: SEARCH_TOOLS`.

**`editorMenu.ts`'s two `tools: ['Read']` sites (`askAboutImage()`, `extractImageContent()`) are
deliberately left unwired.** Both send an absolute OS path to an *image* file and rely on
Claude's native multimodal `Read` tool to view it — `inlineChat()` has no `images` parameter at
all (unlike `Session.send()`, which does — see "Attachment delivery" above), so no image data
reaches any non-Claude model from these two call sites by any means today.

## Query metadata cache (issue #130)

Capture-and-cache, not a persistent query — see
`.docs/decisions/2026-09-04-persistent-query-cache.md` for the full decision, including an
empirical correction to when during a turn the capture is actually safe.

`Session` holds a `QueryMetadataCache` (`{contextUsage?, commands?, agents?}`) refreshed by
`refreshQueryMetadataCache(query, prev, onDebug?)` — an exported, independently-testable
function (`test/queryMetadataCache.test.ts`) that calls `Query.getContextUsage({detail:
'summary'})`, `Query.supportedCommands()`, and `Query.supportedAgents()` together via
`Promise.all`, and either returns a fresh cache (all three succeeded) or the **unchanged**
`prev` cache (any one rejected) — never throws, always emits one `debugTrace()` line on
failure via the optional `onDebug` callback.

**Timing, not incidental.** These are control requests, only answerable while the turn's
`Query` handle's underlying CLI process is still alive. For this codebase's single-turn
(string-`prompt`) `query()` model, that window closes at the terminal `SDKResultMessage` —
calling any of the three control requests at or after that message always rejects (`Query
closed before response received` / `ProcessTransport is not ready for writing`), confirmed
empirically. `Session.send()` therefore calls `refreshQueryMetadataCache()` once per
non-partial `assistant` SDKMessage in the `for await` loop — there can be more than one per
turn in a tool-loop conversation — with each call overwriting the previous, so the cache ends
up holding whatever was captured at the *last* `assistant` message of the turn. A turn with no
`assistant` messages at all (e.g. an immediate error) leaves the cache untouched.

`'detail': 'summary'` is used deliberately (not `'full'`, the SDK default) — it answers from
the last response's usage and local estimates, without the per-category token-count API calls
`'full'` makes, keeping this cheap enough to call once per `assistant` message.

**Public surface**, all on `Session`:

- `get cachedContextUsage(): SDKControlGetContextUsageResponse | undefined` — `totalTokens`,
  `maxTokens`, `percentage`, model, and a per-category breakdown (`sdk.d.ts:3586`).
  `undefined` before the first successful capture.
- `get cachedSupportedCommands(): SlashCommand[] | undefined` — the CLI's actual loaded
  slash-command/skill list.
- `get cachedSupportedAgents(): AgentInfo[] | undefined` — the CLI's actual loaded subagent
  list.
- A `session.metadata` `SessionEvent` (`data` is a shallow copy of the current
  `QueryMetadataCache`) dispatched once per capture *attempt* (successful or not, so the view
  can re-render on a no-op refresh too) — `synapseView.ts` reacts by re-reading the getters
  above rather than trusting the event payload as authoritative, since `Session` is the single
  owner of the cache.

Populated the same way for a local-agent-endpoint model as for Claude, post-#220 — every model's
query goes through a real `Query` handle now, so there is no branch that skips this cache
anymore. See `chat-view.md`'s "Context-window gauge and live command/agent lists" for how the
view consumes this cache (including the directory-scan fallback for a session that hasn't sent a
turn yet).

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

The `localAgentEndpoint` field is private — consumed only internally by `buildEnv()`. Callers
that need the local agent endpoint config (e.g. `buildSessionConfig`) receive it directly from
`main.ts`.

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
