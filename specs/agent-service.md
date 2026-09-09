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
  `window.require` is unavailable. Mirrors `mcpBridge.ts`'s `_synapse/.mcp.json` read, the closest
  existing precedent for a small vault-local JSON config.
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
- `inlineChat()`/`Session.send()` already had `app?: App` from #150/#138's local-model vault-tool
  gate; it's now *also* read on the real Agent SDK path (previously ignored there). `SynapseView`
  already passed `app: this.app` unconditionally on every `Session.send()` call, and
  `searchPanel.ts`'s two `inlineChat()` calls already passed `app: this.app` (#167) — no change
  needed for the chat panel or search. `editorMenu.ts` (9 call sites), `editModal.ts`,
  `telegramBot.ts`, and `runExecutor.ts`'s `executeWithClaude()` (batch loops/runs) did not
  previously pass `app` to `inlineChat()` and were updated to pass it, purely to make the vault
  path derivable — none of their own settings-building logic changed.
- Passing `app` alone does not newly enable the local-model branch's `vaultTools` gate
  (`supportsTools && options.app && options.canUseTool` — see #150/#138 above): every site updated
  here still omits `canUseTool`, so that gate remains closed exactly as before, per #167's
  `editorMenu.ts` tests.

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

- **Gating:** Gated on local-backend availability (`isLocalBackendConfigured()`). If not
  configured or unavailable, the delegation server is omitted from query options.
- **Tools exposed:** `cheap_generate` (single prompts/sub-tasks) and `bulk_summarize`
  (multi-item summaries processed in parallel via `Promise.allSettled`).
- **Routing:** When a local agent endpoint (issue #122, see "Local agent endpoint" above) is
  configured, the tool handler resolves the provider's default model
  (`resolveDefaultModel()`, exported from `providerModels.ts`) and delegates via `chat()` — the
  same real-Agent-SDK path a direct local-model chat query takes — instead of
  `executeLocalProviderQuery()`. Without the endpoint configured, it still executes sub-tasks via
  `executeLocalProviderQuery()` unchanged, keeping routing, formatting, and cost under plugin
  control.
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

## BYOK local provider routing

Local/BYOK models (Ollama, or another OpenAI-compatible endpoint) do not flow through the Claude
CLI subprocess **by default** — `buildEnv(modelId?)` only ever sets `ANTHROPIC_API_KEY` for
`authType: 'apiKey'` auth and otherwise inherits the process env; without a configured local agent
endpoint (below) it does not repoint `ANTHROPIC_BASE_URL` at a local backend, because the CLI
speaks the Anthropic Messages API and historically could not talk to an OpenAI-shaped `/v1`
endpoint. (An earlier `buildEnv(forLocalModel = true)` branch attempted this — issue #118 removed
it as dead code; no caller passed `true`. Issue #122, below, reintroduces the same mechanism —
`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` repointed at a local endpoint — but as an explicit,
user-configured, per-model routing decision rather than a global default.)

Instead, `isLocalModel(modelId)` decides per-model whether a query is routed to
`executeLocalProviderQuery()` (`providerModels.ts`) — a separate, hand-rolled ReAct loop that talks
directly to the configured provider's OpenAI-compatible `/v1/chat/completions` endpoint — or to the
real Agent SDK via the CLI. `isLocalModel` deliberately checks `sdkModels` and the `/^claude-/i`
prefix guard **before** `customModels` membership: `customModels` is whatever the provider's last
`/v1/models` response contained (`setCustomModels()`), and a provider/aggregator catalogue can
return ids that collide with, or resemble, genuine Claude ids (e.g. an OpenRouter-style
`anthropic/claude-*` id, or — historically — the removed `anthropic` BYOK preset echoing real
`claude-*` ids back). Checking the SDK-known/Claude-shaped guards first ensures such an id can
never be misrouted into the degraded local loop (no skills, subagents, sessions, permission modes
or streaming), regardless of what a local catalogue happens to contain.

### Local agent endpoint: routing local models through the real Agent SDK (issue #122)

**What changed and why it's possible now.** Ollama v0.14.0+ implements the Anthropic Messages API
natively at its own address (`http://localhost:11434`) — `ANTHROPIC_API_KEY` is required by the
protocol but its value is ignored. Pointing `ANTHROPIC_BASE_URL` at it (or at any other
Messages-API-speaking endpoint) lets a local model run through the *same* Claude CLI/Agent SDK as
Claude sessions — skills, subagents, sessions, permission modes, and streaming — instead of the
degraded ReAct loop below. This closes the gap the previous paragraph's `buildEnv(forLocalModel)`
removal (issue #118) left open: at the time, no Messages-API-speaking local endpoint existed
without a fragile third-party translating proxy (e.g. LiteLLM) in front of Ollama's older
OpenAI-shaped `/v1` surface; Ollama's own native support removes that dependency.

**Additive, not a replacement — this issue does not touch the local-loop branches themselves.**
Retiring `executeLocalProviderQuery()` (fully or partly) once every caller can reach the SDK path
is tracked separately as issue #220, sequenced strictly after this lands and is verified. Until
then, the two mechanisms coexist, selected per query by whether the endpoint is configured:

- **`AgentService.isLocalAgentEndpointConfigured(): boolean`** — true when a non-empty
  `LocalAgentEndpointConfig.baseUrl` was supplied to the constructor (settings: `Advanced → Local
  agent endpoint (advanced)`, independent of both `AuthConfig`/`authType` — used only for Claude
  models — and the BYOK provider preset — used only for local-model *discovery/catalogue*, not
  execution).
- **Per-turn routing decision, not global.** Every local-model branch that used to check only
  `isLocalModel(modelId) && providerConfig` (`chat()`, `inlineChat()`, `Session.send()`) now also
  requires `!isLocalAgentEndpointConfigured()` to take the `executeLocalProviderQuery()` branch.
  When the endpoint *is* configured, those branches fall through to the same real-SDK `query()`
  call a Claude model would use — a Claude-model query in the same session/conversation is
  unaffected either way, since the check is keyed off that call's own `modelId`, not a global mode
  switch.
- **`buildEnv(modelId?)`** gained the `modelId` parameter: when `modelId` is classified local
  (`isLocalModel()`) *and* the endpoint is configured, it sets `ANTHROPIC_BASE_URL` to the
  endpoint's base URL and `ANTHROPIC_API_KEY` to its configured key (falling back to the literal
  `'ollama'` when blank, per Ollama's own docs) **instead of** the auth-branch values below it —
  additive to, not a replacement of, the existing subscription/API-key branches, which still run
  unchanged for every Claude-model call and for local-model calls when the endpoint isn't
  configured. Every call site that builds `env` now threads its own `model`/`queryOptions.model`
  through to `buildEnv()` for this reason (`chat()`, `inlineChat()`, `createQuery()`).
- **`routeQueryOptions()`'s model handling** used to unconditionally clear `opts.model` for any
  `isLocalModel()` id (there was no Claude model such an id could resolve to, since local queries
  never reached this far). It now preserves the id instead when the endpoint is configured, so the
  requested local model id (e.g. `llama3.1`) actually reaches the endpoint as the CLI's `model`
  request field, rather than being dropped in favor of the CLI's own default.
- **Model discovery is unchanged.** This issue only changes how an already-selected local model's
  *query* executes; the BYOK provider preset's catalogue fetch (`fetchProviderModels()`,
  `setCustomModels()`) still backs the model picker exactly as before.
- **Security note (settings UI copy, per the repo's network-access convention).** A user-supplied
  endpoint URL redirects the *entire* agent loop for that query, including tool calls, to whatever
  is listening there — the settings UI explicitly says so and recommends only pointing it at a
  trusted endpoint (loopback Ollama by default). This is the same posture #138's local-loop tool
  approval already takes for a remote BYOK endpoint (`isRemoteEndpoint` in the approval prompt),
  just stated once up front for this setting instead of per tool call, since a real Agent SDK
  session's own tools run inside the CLI process rather than through the plugin's per-call
  approval adapter.
- **Open questions, deliberately left for empirical verification rather than blocking the
  design:** whether cost accounting, permission-prompt behavior, and session `resume` work
  end-to-end against Ollama's Messages API implementation specifically (it may not cover every CLI
  expectation) — see the issue for what deploy-test against a live Ollama instance found.

### BYOK local provider conversation history (issue #135)

Unlike the real Agent SDK path, `executeLocalProviderQuery()`'s ReAct loop has no CLI process and
no persisted session to `resume` — every call previously rebuilt its `messages` array from
scratch (system message + exactly one current-turn user message), so two consecutive turns on the
same local model had no memory of each other, model switch or not. `executeLocalProviderQuery()`
now accepts an optional `history` param (`LocalHistoryMessage[]`, exported from
`providerModels.ts`) threaded into the request between the system message and the current turn.

- **What's carried:** only `role: 'user' | 'assistant'` text turns. `ChatMessage` (`types.ts`) has
  no tool-call fields, so prior tool calls/results cannot be reconstructed even in principle, and
  replaying partial tool state would also break OpenAI-compatible APIs (a `tool` message needs a
  `tool_call_id` matching an immediately preceding assistant `tool_calls` entry this history can't
  supply). `role: 'info'` messages (UI notices, not conversation) and the separate `reasoning`
  field are both excluded.
- **Where the mapping lives:** `providerModels.ts` must not import view types, so the
  `ChatMessage[]` -> `LocalHistoryMessage[]` mapping lives in `sessionConfig.ts`
  (`buildLocalHistory()`), not there. `SynapseView.handleSend()` calls it (only when
  `isLocalModel()` is true) and passes the result as `Session.send({history})`
  (`agentService.ts`), which threads it straight through to `executeLocalProviderQuery()`
  unchanged. Image attachments on historical messages get the same base64 resolution as the
  current turn (`resolveImageAttachments()`), since local models have no agentic `Read` tool
  regardless of which turn an image was attached to.
- **Budget:** a character budget, not a turn cap — `ChatMessage.content` can carry inlined
  attachment text tens of thousands of characters long, so a turn count doesn't bound the
  payload the way a character count does. `buildBudgetedHistory()` drops whole messages from the
  oldest end until the transcript fits; it never truncates mid-message and the system message
  (pushed separately, unconditionally) is never part of the budget or at risk of being dropped.
  Character count is a deliberately conservative proxy for token count
  (`HISTORY_CHARS_PER_TOKEN = 3`; real text runs closer to ~4 chars/token for English prose, lower
  for code/CJK — picking a low divisor avoids under-budgeting either).
- **Sizing the budget:** for `preset: 'ollama'`, `getOllamaContextLength()` reads the model's
  advertised maximum context length from the same `/api/show` call `fetchProviderModels()` already
  makes for capability discovery (`model_info["*.context_length"]`; the exact key varies by model
  architecture, so any key ending in `.context_length` is accepted), cached alongside the existing
  vision/tools cache. That figure is only ever used as a ceiling to stay well under
  (`OLLAMA_CONTEXT_SAFETY_FRACTION = 0.25`), never as available headroom: Ollama's own effective
  `num_ctx` for a request defaults to a few thousand tokens regardless of what the model can
  technically support, and **silently truncates the oldest tokens off an over-long request with no
  error** — unlike OpenAI-compatible backends, which return HTTP 400 on overflow (a visible
  failure). Any backend that publishes nothing (every non-Ollama preset; a failed/erroring
  `/api/show` call) falls back to a fixed conservative default (`DEFAULT_HISTORY_CHAR_BUDGET`).
- **Scope:** `Session.send({history})` is only read in the local-model branch — the Agent SDK
  branch carries its own continuity via `resume` and the CLI's persisted session id (see "BYOK
  local provider routing" above). That continuity is necessarily one-sided, though: it only
  covers turns that themselves went through the CLI. See "Bridging local-provider turns into the
  SDK session (issue #137)" below for the gap this leaves and how it's closed.

Full feature parity for a local model — running it through the actual Agent SDK — requires a
Messages-API-speaking endpoint in front of it (Ollama v0.14.0+ itself, or a translating gateway
such as LiteLLM for backends that don't speak it natively) and `ANTHROPIC_BASE_URL` pointed at
that endpoint; see "Local agent endpoint: routing local models through the real Agent SDK (issue
#122)" above for how `buildEnv()`/`routeQueryOptions()` now support this when the endpoint is
configured. This history-bridging mechanism (`Session.send({history})` and #135/#137 generally)
still only applies to the `executeLocalProviderQuery()` branch — when the local agent endpoint is
configured, the real Agent SDK's own `resume`/persisted-session continuity applies instead, the
same as for a Claude model.

### Bridging local-provider turns into the SDK session (issue #137)

**The two-store problem.** Continuity for the two provider paths comes from two independent
stores that don't know about each other:

- **Agent SDK path:** the transcript lives in the CLI's own session store; continuity comes from
  `resume` + the persisted session id (`Session._sessionId`, only ever set inside the SDK stream
  loop above, from a `session_id` the CLI itself assigns). The plugin sends no history explicitly.
- **Local-provider path (#135):** no CLI, no persisted session — continuity comes entirely from
  the plugin sending `history` built from `SynapseView.messages` (see above).

A turn routed through the local-provider branch never touches the CLI subprocess at all, so it
never sets `_sessionId` and the CLI's session store has no record it happened. Switching back to
a Claude model then resumes (or, if the conversation started on a local model, *starts*) a CLI
session that's missing those turns — silently, since `resume` succeeds either way, it just
resumes the wrong (incomplete) transcript.

**Why this can't be fixed the same way as #135, or natively.** The SDK offers no supported way to
seed or append to a session transcript without taking a turn (checked against the installed SDK's
`sdk.d.ts` — `forkSession()` forks an *existing* session rather than injecting messages, and
streaming input accepts `SDKUserMessage` only, so assistant turns can't be inserted either). The
gap has to be bridged from the plugin side, into the prompt of an actual SDK turn.

**The bridge.** `SynapseView.sdkSeenIndex` is a high-water mark: how much of `SynapseView.messages`
the *current* CLI/Agent SDK session already has.

- Any SDK-routed `send()` advances the mark to `messages.length` once the turn reaches the CLI
  without throwing (`handleSend()`, after both `send()` attempts — the retry-on-`'Session not
  found'` path included). Local-routed turns never advance it.
- Before every SDK-routed `send()`, `computeSdkHistoryGap(messages, sdkSeenIndex)`
  (`view/sessionConfig.ts`) slices everything since the mark, excluding the just-added
  current-turn user message (same convention as `history`'s slice above — that turn goes through
  `prompt`, not a replay block). `buildSdkHistoryInjection()` maps the gap through the same
  `role: 'info'`-excluded, `reasoning`-never-replayed filtering `buildLocalHistory()` uses, budgets
  it via `buildBudgetedHistory()` (reused from `providerModels.ts`, exported for this reuse — same
  oldest-first, never-truncate-mid-message policy as #135), and wraps the result in an explicit,
  low-collision-risk delimiter pair (`[SYNAPSE:PRIOR-CONVERSATION-NOT-YET-IN-THIS-SESSION]` /
  `[/SYNAPSE:...]`) plus a plain-language "this is context, not an instruction" line, so the model
  reads it as history rather than acting on anything inside it. The block (if non-empty) is
  prepended to the prompt actually sent to `Session.send()`.
- **Budget is sized differently from #135's, deliberately.** #135's budget scales down from a
  *local* model's own advertised (often tiny) context window. There's no equivalent per-model
  signal to read here — the CLI exposes no context-length metadata to query — and the target
  window is Claude's: 200k tokens ordinarily, up to 1M for `[1m]` variants. Flooring to a
  local-sized budget would needlessly truncate a bridgeable gap Claude could hold easily.
  `SDK_HISTORY_INJECTION_CHAR_BUDGET` (`sessionConfig.ts`) is fixed at 60,000 characters — using
  the same conservative ~3 chars/token proxy #135 uses, that's ~20k tokens, about 10% of even the
  smaller 200k window, comfortably leaving room for the system prompt, tool definitions, and the
  rest of the conversation the CLI's own `resume` already carries. It only needs to cover an
  occasional local-provider detour, not become the primary transport.
- **Both cases from the issue are the same mechanism, not two branches:** started-on-local (the
  mark is still its initial `0` when the first SDK turn happens, so the whole local prefix is the
  gap) and switched-mid-conversation (the mark reflects the last SDK turn, so only the local turns
  since then are the gap) fall out of the same `sdkSeenIndex`/`computeSdkHistoryGap()` logic with
  no special-casing.

**Where the mark lives, and why it survives a rebuilt `Session` (issue #104 interaction).**
`sdkSeenIndex` is a field on `SynapseView`, not `Session` — deliberately, since `ensureSession()`
tears down and rebuilds the `Session` object on every `configDirty` change (model, agent,
reasoning-effort, tool toggles), while `SynapseView.messages` and the conversation itself survive
that rebuild unchanged (see "Carrying a conversation across a rebuilt Session" above). Had the
mark lived on `Session`, a config change mid-conversation (e.g. switching *to* the local model
that triggered the gap in the first place) would silently reset it to a fresh session's default,
re-injecting already-seen history on the very next SDK turn. Lifecycle:

- Reset to `0` only when the conversation itself resets — `newConversation()`.
- Set to `messages.length` (fully seen) rather than reset when a different session is *loaded* —
  cold resume (`selectSession()`'s SDK-resume path, `sessionSidebar.ts`) replays `messages`
  straight from the CLI's own persisted transcript (`getSessionMessages()`), so by definition the
  CLI already has every one of them.
- Carried through unchanged on background-session save/restore
  (`saveCurrentToBackground()`/`restoreFromBackground()`) — added to `BackgroundSession`
  (`view/types.ts`) alongside `messages`, since a backgrounded session is a distinct in-flight
  conversation with its own mark, not the foreground one being reset.
- Left untouched by `ensureSession()`'s `configDirty` rebuild — it isn't part of `SessionConfig`
  and nothing in the rebuild path writes to it, so it naturally carries forward with `messages`.

**Known limitation, not a bug:** the injected block becomes part of the actual prompt text sent to
(and persisted by) the CLI, so a later cold-resume replay of that session
(`AgentService.getSessionMessages()`) will show the delimited block verbatim as part of that
turn's raw user-message content, rather than it being invisible plumbing. This is the same
"inject into the prompt" mechanism the issue itself specifies (no native alternative exists — see
above), and cosmetic only; it doesn't affect the model's behavior or which content participates in
the visible chat UI (`SynapseView.messages`, which never includes the injected block — only the
outgoing wire prompt does).

### Vault tools and approval gate in the chat panel (issue #138)

> **Triggers were removed entirely in issue #188** (`src/triggers.ts`, `src/triggerExecutor.ts`
> both deleted; see `run-executor.md`'s "Current status"). The trigger references below describe
> the design rationale as it stood when #138/#150/#167 were written, when triggers were still the
> only unattended caller of `vaultTools`/`executeLocalProviderQuery()`'s ReAct loop; that
> unattended-caller role is now filled by `batchLoopExecutor.ts` alone, via `runExecutor.ts`.

Before #138, `vaultTools` (`vaultTools.ts` — `read_note`, `list_notes`, `search_notes`) was wired
into exactly one call site, the now-removed `triggerExecutor.ts`. `Session.send()`'s local-model branch called
`executeLocalProviderQuery()` with `prompt`/`systemPrompt`/`model`/`images`/`history` but no
`tools`, so a local/BYOK model's ReAct loop degenerated to a single completion in chat — it could
not read, list or search notes, even though the same model could do exactly that when driving a
trigger.

**Why this needed an approval gate, not just wiring the array through.** The local
tool-execution loop (`executeLocalProviderQuery()`) calls `tool.execute(args, params.app)`
directly, with no permission check anywhere in `providerModels.ts` — tolerable for triggers (the
user configured a specific trigger deliberately; it runs unattended by design) but not for
interactive chat, where the real Agent SDK path already gates tool use through `canUseTool`
(`CanUseTool`, built as `permissionHandler` in `SynapseView.buildSessionConfig()`, opening
`ToolApprovalModal`). Wiring the same tools into chat without a gate would put ungated tool
execution right next to a path that asks permission.

**Decision (issue comment, authoritative): reuse the existing approval flow**, not a second one.
Approving `read_note` looks identical whether the model is Claude or a local/BYOK model.

- **The gate lives in `providerModels.ts`, but stays neutral.** `executeLocalProviderQuery()`
  accepts an optional `onApproveTool?: LocalToolApprovalHandler` — `(toolName, input, {toolUseID,
  endpoint, isRemoteEndpoint}) => Promise<{allow: boolean; message?: string}>`. No SDK or view
  types are imported into `providerModels.ts` for this (architecture rule): the shape is
  deliberately plain, the same way `history` was threaded in as a value for #135 rather than
  `providerModels.ts` importing `ChatMessage`. When `onApproveTool` is omitted (the trigger path,
  unchanged), a tool call executes immediately exactly as before #138 — the gate is opt-in per
  call, not a hard requirement of the loop.
- **The adapter lives in `agentService.ts#Session.send()`**, the one file that already imports
  both the SDK's `CanUseTool` type and `providerModels.ts`. The local-model branch wraps the
  session's own `queryOpts.canUseTool` (already present on `SessionConfig` — built once in
  `SynapseView.buildSessionConfig()` for the Agent SDK path) into a `LocalToolApprovalHandler`
  that calls it with a synthesized `title`/`description` and forwards its `PermissionResult` back
  as `{allow, message}`. Fail-closed both ways: a handler that throws, or a `canUseTool` call that
  resolves to anything but `{behavior: 'allow'}`, denies the call.
- **Endpoint visibility.** `executeLocalProviderQuery()` computes `endpoint` (the configured
  `baseUrl`) and `isRemoteEndpoint` (`!isLoopbackEndpoint(baseUrl)` — true unless the host is
  `localhost`/`127.0.0.1`/`::1`) itself, since it already has `baseUrl` in scope, and passes both
  in the context handed to `onApproveTool`. The `Session.send()` adapter puts `endpoint` into the
  approval prompt's `description` (`ToolApprovalModal` already renders that field as a row) so
  `read_note` against `http://localhost:11434` reads visibly differently from `read_note` against
  `https://openrouter.ai` or an Azure endpoint — the first stays on the machine, the second sends
  note content to a third party. No settings-only opt-in and no silent-trust-loopback shortcut:
  both were explicitly rejected in the issue's decision comment in favor of per-call visibility.
- **A denied call never runs `tool.execute()`.** The loop returns a `tool`-role message to the
  model (`Tool "<name>" was not approved[: <message>]`) instead of throwing — the model sees a
  normal (if unsuccessful) tool result and can adapt its next turn, rather than the whole query
  erroring out.
- **Capability gate**, same test triggers already use: `Session.send()` only offers `vaultTools`
  when `modelInfo?.supportsTools !== false` (looked up via `AgentService.getModels()`) — a
  catalogue that explicitly says "no tools" is honored, a model with no capability info (most
  OpenAI-compatible catalogues) defaults to allowed, per #129's `deriveCatalogueCapabilities()`.
- **MCP tools are deliberately NOT offered in chat**, unlike triggers (which merge
  `McpBridgeSession`'s tools alongside `vaultTools`). Triggers run once per file event, so
  spawning/tearing down an MCP bridge once per trigger is cheap relative to the trigger itself;
  chat's local branch runs once per user message in a potentially long back-and-forth
  conversation, and `Session` has no session-scoped owner to keep an MCP bridge alive across turns
  without a larger lifecycle change than this issue's gap called for. MCP tools are also arbitrary
  and not necessarily read-only, unlike the three built-ins, so the smaller surface is also the
  more conservative default for this increment. Revisit as a separate issue if interactive chat
  needs MCP tools.
- **`App` plumbing.** Neither `Session` nor `AgentService` holds an `App` reference (SDK/session
  plumbing stays UI-agnostic). `Session.send()` gained an `app?: App` option, threaded in the same
  per-call shape as `images`/`history` — `SynapseView` passes `this.app` on every send; it's only
  read in the local-model branch (forwarded to `executeLocalProviderQuery()` as the `App` instance
  vault tools execute against) and ignored on the Agent SDK path, whose own tools run inside the
  CLI process.

### Vault tools and approval gate in `inlineChat()` (issue #150)

#138 (above) closed this gap for the chat panel's `Session.send()`. `inlineChat()`'s local-model
branch — the second call site running local/BYOK models, used by editor actions
(`editorMenu.ts`), the edit modal (`editModal.ts`) and search (`searchPanel.ts`) — had the exact
same shape of gap: `prompt`/`systemPrompt`/`model` only, no `tools`, no `app`. `triggerExecutor.ts`
gave the same models the full ReAct kit; `inlineChat()`'s local branch gave them a bare one-shot.

**Same capability gate, same adapter, one deliberate difference in reachability.**

- `inlineChat()` gained an `app?: App` option, the same per-call shape as `Session.send()`'s.
  Ignored on the Agent SDK path (that path's own tools run inside the CLI process); read only in
  the local-model branch.
- **Capability gate is identical**: `modelInfo?.supportsTools !== false` via `getModels()`.
- **The `CanUseTool -> LocalToolApprovalHandler` translation is not duplicated.** It was factored
  out of `Session.send()` into a module-level `adaptCanUseToolToLocalApproval(canUseTool, signal)`
  in `agentService.ts`, and both `Session.send()` and `AgentService.inlineChat()` call it — per the
  issue's requirement that this translation exist in exactly one place.
- **Reachability differs from `Session.send()` on purpose.** `Session.send()` offers `vaultTools`
  whenever `supportsTools && app` — if the session has no `canUseTool` (shouldn't happen from the
  chat panel, which always builds one), the local tool loop falls back to running ungated, the same
  "unattended by design" behavior the trigger path already has. `inlineChat()` does **not** fall
  back that way: it only offers `vaultTools` when `supportsTools && app && canUseTool` are *all*
  present. Editor actions are one-shot rather than an ongoing attended conversation, so there is no
  trigger-like "the user configured this to run unattended" precedent to lean on — every tool call
  `inlineChat()`'s local branch makes must go through the same approval path as the chat panel's,
  never a silent auto-approve next to it. A caller that supplies `app` but not `canUseTool` gets no
  tools at all (the model degrades to the pre-#150 bare one-shot) rather than an ungated one.
- MCP tools are deliberately **not** offered here either, for the same spawn/teardown-cost
  reasoning `Session.send()`'s comment gives — that reasoning is specifically about paying the cost
  once per conversational turn, which doesn't automatically carry over to `inlineChat()`'s one-shot
  calls, but extending to MCP is left as a separate question.

**Caller reachability as of #150 — file-boundary note.** #150 was scoped to `agentService.ts`
only; it did not touch `editorMenu.ts`, `editModal.ts` or `searchPanel.ts`. As of that change,
*none* of `inlineChat()`'s callers passed `app` or `canUseTool`, so the new capability existed but
was not yet reachable from any UI call site — every existing call still got the pre-#150 bare
one-shot on a local model. #167 (below) wires the two call sites that actually request tools on
the SDK path.

### Wiring `inlineChat()`'s callers (issue #167)

#150 left every `inlineChat()` caller unreachable — see the file-boundary note above. Of the ~22
call sites, only two genuinely request tools on the SDK path and should offer the local-model
analogue: `searchPanel.ts`'s basic and advanced search (`tools: ['Read', 'Glob', 'Grep']`,
`maxTurns: 40`). The rest pass `tools: []` deliberately — one-shot generation actions (create
note, create canvas, edit selection) that have no tools on the Claude path either — and are
untouched.

**The blocking question this issue had to resolve: what approves a local tool call for a caller
whose UI is attended but whose turn budget (`maxTurns: 40`) makes per-call approval unusable.**
#150's `inlineChat()` gate is deliberately fail-closed — `supportsTools && app && canUseTool` all
required, with no "unattended by design" fallback the way `Session.send()` (and, at the time,
`triggerExecutor.ts`) have — so wiring search naively (reusing the chat panel's `ToolApprovalModal`-backed
`canUseTool`) would mean up to 40 approval modals for a single search. Approving each call
individually was rejected as unusable UX; running fully ungated (no `canUseTool` at all) would
have meant reintroducing exactly the silent-fail-open pattern #150's method comment explicitly
rules out.

**Resolution: `autoApproveReadOnlyTools`, a dedicated read-only-only `CanUseTool` — not a new
"attended-but-automated" permission concept, and not #151's `resolveToolApprovalPolicy()`
either.** This is deliberately narrower than both:

- It is **not** #151's policy (`src/runExecutor.ts`, "Tool approval policy" — governs
  `batchLoopExecutor.ts`'s unattended runs via `runExecutor.ts`, where `'ask'` means "no human to
  ask, so deny" because those runs may request write-capable tools; at the time #151 was written
  this also governed the since-removed trigger executor — see the note above). `autoApproveReadOnlyTools`
  is attended (a human clicked "Search"), and every call site wiring it in restricts `tools` to
  the read-only set — the two contexts differ on both axes (attended vs. unattended, read-only vs.
  write-capable) and are kept as two separate mechanisms rather than unified, so neither
  accidentally inherits the other's assumptions.
- It is **not** a new "attended-but-automated" policy tier either, despite the issue framing it
  that way initially. A verified spike against the live CLI (run for #151, reused here since it
  answers the same question) showed the Agent SDK path *never invokes* `canUseTool` for
  `Read`/`Glob`/`Grep` at all — the CLI auto-approves them before the callback would even fire —
  while a write tool (`Write`) still goes through `canUseTool` and is denied when there's no
  attended handler. `vaultTools` (`read_note`/`list_notes`/`search_notes`) are the local-path
  analogue of `Read`/`Glob`/`Grep` and are genuinely read-only (`app.vault.read()` / `getFiles()`
  / `getMarkdownFiles()` only — never `modify`/`create`/`delete`/`rename`). So auto-approving them
  on the local path reproduces the Claude path's own shipped behavior for the same caller, rather
  than inventing a laxer policy next to it. `searchPanel.ts` already runs `bypassPermissions` +
  `allowDangerouslySkipPermissions` on its advanced-search SDK path when `settings.toolApproval
  === 'allow'` — the local path granting exactly the read-only three is strictly less permissive
  than what search already does on Claude in that mode.
- `autoApproveReadOnlyTools` (`agentService.ts`, exported) is a `CanUseTool` that allows a tool
  only if its name is in `READ_ONLY_TOOL_NAMES` (`Read`/`Glob`/`Grep` on the SDK path,
  `read_note`/`list_notes`/`search_notes` on the local path) and **denies anything else**. The
  check is in the handler rather than left to the caller on purpose: `inlineChat()` forwards the
  same `canUseTool` to the raw Claude-path `query()` call too (it is a single option, not two),
  so an unconditional always-allow handler would silently grant writes at any future call site
  that wired it in alongside a write-capable tool. Restricting `tools` at the call site is still
  the primary control; failing closed on the tool name keeps the guarantee in code rather than in
  a doc comment. Call sites that legitimately need write-capable tools use #151's
  `resolveToolApprovalPolicy()` instead.
- Wired into `searchPanel.ts`'s `handleBasicSearch()`/`handleAdvancedSearch()`: both now pass
  `app: this.app, canUseTool: autoApproveReadOnlyTools` alongside their existing `tools:
  SEARCH_TOOLS`. No second `CanUseTool -> LocalToolApprovalHandler` adapter was added —
  `adaptCanUseToolToLocalApproval()` (shared since #150) still does that translation in exactly
  one place; `autoApproveReadOnlyTools` only supplies what `canUseTool` resolves to.

**`editorMenu.ts`'s two `tools: ['Read']` sites (`askAboutImage()`, `extractImageContent()`) are
deliberately left unwired — not an oversight.** Both send an absolute OS path to an *image* file
and rely on Claude's native multimodal `Read` tool to view it. `vaultTools`'s `read_note` is not
an analogue for that: it resolves only vault-relative paths (`app.vault.getAbstractFileByPath()`)
and returns `app.vault.read()` as UTF-8 text — an absolute OS path would resolve to "File not
found", and even a resolvable path would return raw bytes/garbled text, not a vision read. More
fundamentally, `inlineChat()` has no `images` parameter at all (unlike `Session.send()`, which
does — see "Attachment delivery" above) — no image data reaches the local-model branch from these
two call sites by any means today, so wiring vault tools in would add spurious failed tool calls
without fixing the actual gap (giving `inlineChat()` an `images` parameter is a separate,
larger feature, out of scope here).

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

Never populated on the BYOK local-model branch (`executeLocalProviderQuery()`) — that path
never touches a `Query` handle at all, so `cachedContextUsage` stays `undefined` for the entire
conversation on a local model, by construction rather than by an explicit gate. See
`chat-view.md`'s "Context-window gauge and live command/agent lists" for how the view consumes
this cache (including the directory-scan fallback for a session that hasn't sent a turn yet).

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
