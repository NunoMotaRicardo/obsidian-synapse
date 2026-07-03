# chat-view

Source: `src/synapseView.ts` (panel shell, session orchestration), `src/toolErrors.ts`
(friendly write/edit tool error formatting), plus `src/view/*`:

| File | Role |
|---|---|
| `configToolbar.ts` | Agent / model / reasoning-effort / skills / tools / working-dir / debug controls |
| `inputArea.ts` | Message input, slash-command prompts, attachments, vault scope button |
| `chatRenderer.ts` | Markdown rendering of messages, reasoning blocks, tool-call details |
| `sessionSidebar.ts` | Session list, restore (cold resume via `getEvents()`), rename/delete, background sessions |
| `searchPanel.ts` | AI vault search tab (basic/advanced) |
| `sessionConfig.ts` | Builds `SessionConfig` from selected agent/skills/tools/settings |

Modals (`src/modals/*`): tool approval, elicitation forms, user input (ask_user), edit modal,
vault scope, folder tree.

## Behavior contracts

- Streaming: sessions are created with `streaming: true`; renderer accumulates
  `assistant.message_delta` / `assistant.reasoning_delta`, finalizes on `assistant.message`.
- Reasoning menu (brain icon) shows only when the selected model reports
  `capabilities.supports.reasoningEffort` and a non-empty `supportedReasoningEfforts`; an
  unsupported persisted level resets to `''`.
  - Effort levels are iterated from `supportedReasoningEfforts` and stored as a free string
    (`settings.reasoningEffort`), because models report values beyond the SDK's
    `ReasoningEffort` union (e.g. `max`, `none`). `none` is labelled "Off"; `''` = model
    default. Re-selecting the active level toggles back to `''`.
  - A **Reasoning summary** submenu (gated on the same capability) sets
    `settings.reasoningSummary` to `''` (model default), `none`, `concise`, or `detailed`.
    `none` suppresses reasoning output, so no reasoning block is rendered (the block is only
    ever created from reasoning events).
  - Both values are passed together on every mid-session `session.setModel()` call so neither
    resets, and flow into new sessions via `sessionConfig` in `synapseView.ts` and
    `bots/telegramBot.ts`. The SDK-boundary cast to `ReasoningEffort`/`ReasoningSummary` is
    localized (the unions lag the values models actually report).
  - A **Long context** toggle in the same menu pins the session to the SDK's
    `long_context` context-window tier (`settings.contextTier`, `'default' | 'long_context'`,
    default `'default'`). Unlike reasoning effort there is **no per-model support signal** —
    `ModelCapabilities.supports` exposes only `vision` and `reasoningEffort`, and `ModelInfo`
    has no long-context flag (only `limits.max_context_window_tokens`). The toggle is
    therefore always shown (the menu shows it even for models that don't support reasoning
    effort, so the model icon stays interactive); the SDK silently ignores `contextTier` for
    models that don't support the tier. `contextTier` rides along on the same mid-session
    `session.setModel()` call (`{reasoningEffort, reasoningSummary, contextTier}`) so toggling
    it doesn't reset reasoning, is omitted from session config when 'default' (matching the
    reasoning omit-when-empty pattern), and flows into new/resumed sessions via buildSessionConfig
    and into the Telegram bot via TelegramBotService.buildBotSessionConfig. `ContextTier` is imported from `../copilot`
    (CopilotService's SDK re-export). Orthogonal to infinite sessions (issue #5): context tier
    sets the window size, infinite sessions controls auto-compaction — they compose.
  - An **Infinite sessions** toggle in the same model-icon menu controls the SDK's
    auto-compaction behavior (`settings.infiniteSessionsEnabled`, default `true` — the SDK
    default). When enabled, the SDK compacts the conversation at ~80% context utilization
    (background) and blocks at ~95% (buffer exhaustion). When disabled, sessions hit the
    context limit and stop. The toggle follows the same patterns as Long context: always shown,
    sets a persisted setting, marks config dirty, omitted from session config when `true`
    (matching the SDK default). `infiniteSessions: { enabled: false }` is passed only when
    the user explicitly disables it. Planned: issue #5.
- **Compaction events in debug view** (issue #5): when the debug toggle is on,
  `session.compaction_start` and `session.compaction_complete` events render inline debug
  blocks in the chat (same visibility gating as tool calls via `.synapse-hide-debug`).
  `compaction_start` shows the pre-compaction token breakdown (conversation / system / tool
  definition tokens). `compaction_complete` shows success/failure, tokens removed, messages
  removed, and the summary content. These are handled in `handleSessionEvent()` alongside
  existing event types.
- Session restore: resume by id with the full current session config, re-select agent via
  `session.rpc.agent.select`, replay history from `session.getEvents()`
  (`user.message`, `assistant.reasoning`, `assistant.message`).
- The active note is attached as context. The working directory defaults to the vault root and
  only auto-updates to the active note's parent folder if `settings.autoUpdateWorkingDirectory`
  is enabled (default `false`). The active note's folder can also be overridden manually in the toolbar.
  To anchor path resolution, the session is configured with standard system instructions containing
  the absolute vault root, active note path, and working directory, preventing the LLM from constructing
  incorrect absolute paths (e.g., nesting file paths under attached image subfolders).
  All of these system-prompt blocks are delivered as
  `systemPrompt: {type: 'preset', preset: 'claude_code', append: ...}` — appended to Claude
  Code's default system prompt, never replacing it. (A plain-string `systemPrompt` replaces the
  whole default prompt and the model stops using tools/reading files; this applies to chat,
  advanced search, and the Telegram bot alike.)
  A compact `[Vault Structure]` block is appended to every session's system prompt listing
  top-level vault folders (name + child count), excluding system folders (`.obsidian`, `.trash`,
  the synapse folder, and any dot-prefixed folder). This gives agents awareness of the vault's
  organization without reading note contents. The scan is performed by `scanVaultStructure()`
  in `configWriter.ts`; the formatter `buildVaultContextBlock()` lives in `sessionConfig.ts`.
  A compact `[Self-Improve]` detection block is appended to every session's system prompt
  (chat, search, and Telegram bot) via `buildSelfImproveHint()` in `sessionConfig.ts`.
  It teaches the active agent to recognize when the user expresses a customization preference
  and propose creating or modifying a Synapse artifact (agent, prompt, skill, or trigger),
  always asking permission before writing. The block includes the current agent name for
  context. It is skipped when the user is already using the `improve-synapse` prompt
  (no double-activation).
  A compact `[Resilience]` block is appended to every session's system prompt (chat, search,
  and Telegram bot) via `buildResilienceHint()` in `sessionConfig.ts` — retry-once-then-ask
  guidance for failed writes/edits and confirm-before-acting guidance for referenced
  attachments; see "Write/edit tool error guidance (issue #78)" below. This matters most for
  the Telegram bot, which runs unattended with `permissionMode: 'bypassPermissions'` and no UI
  to catch a silent failure.
  When `settings.autoIncludeNoteImages` is enabled (default),
  `handleSend()` reads the active note content, scans for image embeds (`![[image.png]]` and
  `![alt](path.png)` syntaxes), resolves them to vault files via `resolveNoteImageEmbeds()`
  (`sessionConfig.ts`), deduplicates against manual attachments, and auto-attaches the first N
  images (capped at `min(settings.maxNoteImages, model.capabilities.limits.vision.max_prompt_images)`)
  as `{type: 'image'}` `ChatAttachment` items. Images beyond the cap are silently skipped.
  The shared `IMAGE_EXTS` constant (`types.ts`) defines the supported image extensions
  (`png, jpg, jpeg, gif, webp, bmp, svg`). Non-vision models are unaffected (the SDK/model
  handles or ignores image attachments gracefully).
- Attachment delivery (issue #77): the input area supports drag/drop (OS and vault files),
  clipboard paste (screenshot to blob), and the paperclip attachment button. The Agent SDK's
  `query()` `Options` has no top-level `attachments` field — `prompt` is
  `string | AsyncIterable<SDKUserMessage>` — so attachments are delivered by **inlining an
  absolute path into the prompt text**, the same "the transport strips extra fields" pattern
  already used for `selection`/`clipboard` content. `buildPrompt()` (`sessionConfig.ts`) inlines
  `file`/`image`/`directory` attachment paths (resolved to absolute OS paths via
  `vaultBasePath`), vault scope paths, clipboard text, and selection text. This gives the model
  a real path it reads itself with its own `Read` tool (which already supports image files).
  `type: 'blob'` attachments (clipboard-pasted images — base64 data, no path) are first written
  to a temp file by `materializeBlobAttachments()` under
  `<os.tmpdir()>/obsidian-synapse-attachments/`, then inlined the same way as file attachments;
  temp files are tracked per-view (`SynapseView.attachmentTempFiles`) and deleted via
  `cleanupAttachmentTempFiles()` in `onClose()` (view unload). For any attachment path that
  falls outside the session's actual `cwd` (`SynapseView.getWorkingDirectory()` — the vault
  root, or a narrower subfolder when the working directory is scoped via the toolbar or
  `autoUpdateWorkingDirectory`) — e.g. out-of-vault files, OneDrive-synced folders, blob temp
  files, or vault-relative attachments outside a scoped working directory —
  `computeAdditionalDirectories()` computes the parent directory and it's passed as
  `Session.send({additionalDirectories})`, merged with the session's own
  `config.additionalDirectories` (see agent-service.md) so the SDK grants read access beyond
  the session `cwd`. Containment is checked with a path-boundary-aware helper (`path.relative`
  based, not raw string prefix matching) so a sibling folder that merely shares a string
  prefix with the boundary (e.g. `vault-backup/` vs `vault/`) isn't miscounted as "inside".
  Attachment tag icons correctly distinguish image types: `type: 'blob'`
  (clipboard paste) and `type: 'file'` with an image extension both display the image icon,
  matching the existing `type: 'image'` path.
  **BYOK local provider multimodal delivery (issue #79):** local/BYOK models have no agentic
  `Read` tool, so a path inlined into the prompt text only gives them text describing a path —
  chat-view sends actual image bytes instead when the selected model is local
  (`AgentService.isLocalModel()`). Before calling `Session.send()`, `SynapseView` calls
  `resolveImageAttachments()` (`sessionConfig.ts`) — skipped entirely for cloud/SDK models to
  avoid unnecessary file I/O — which base64-encodes `type: 'image'` attachments, `type: 'file'`
  attachments with an image extension (`png/jpg/jpeg/gif/webp/bmp`; `svg` is excluded even
  though it's in `IMAGE_EXTS` since `image_url` data URIs for SVG aren't reliably supported by
  vision models), and `type: 'blob'` attachments (reusing their existing base64 `data` directly,
  no re-read). Unreadable/missing files are logged and skipped, not thrown. The result is
  threaded through `Session.send({images})` (`agentService.ts`) to
  `executeLocalProviderQuery()` (`providerModels.ts`), which — only when `images` is
  non-empty — builds the first user message as an OpenAI-compatible multimodal `content` array
  (`[{type: 'text', ...}, {type: 'image_url', image_url: {url: 'data:<mime>;base64,...'}}, ...]`)
  for OpenAI-compatible presets, or (for `preset: 'ollama'`, which calls Ollama's native
  `/api/chat` rather than `/v1/chat/completions`) `content: <prompt text>` plus a sibling
  `images: string[]` of raw base64 (no `data:` prefix) per Ollama's own chat message schema —
  that endpoint rejects the OpenAI array shape outright. Calls with no images keep the existing
  plain-string `content` unchanged for either preset. This is scoped to the chat-view send path
  only — the Telegram bot's
  `inlineChat()` doesn't thread structured attachments today and is unaffected (no regression).
  Non-image file attachments still have no delivery path for local providers (no filesystem
  tool) and stay text-path-inlined — unreadable to the model, but no worse than before.
- Sessions are auto-named `<Agent>: <first message>`; trigger/search sessions are tagged.
  A new session's id is unknown until the first send streams a message: `handleSend()` stores
  the first-prompt snippet in `pendingSessionLabel`, and the `session.init` event (dispatched
  by the `Session` wrapper when the SDK delivers the id — see agent-service.md) adopts the id
  into `currentSessionId`, writes the `[chat] <Agent>: <snippet>` name, and adds the sidebar
  entry. Never write a session-name entry keyed by an empty id: `registerInlineSession` (view
  and editor-menu variants), the edit modal, and advanced search all no-op when `sessionId` is
  empty (aborted queries), and `onOpen()` deletes any legacy `''`-keyed entry left by older
  builds.

## Loop turn/cost thresholds (issue #88)

Opt-in, settings-backed guardrails for interactive Tier-1 chat runs — distinct from the SDK's
raw `maxTurns` cap (which fails silently with "Reached maximum number of turns (N)"): these are
plugin-side limits that auto-cancel the in-flight run via the existing `Session.abort()` path
(`agent-service.md` "Cancellation and timeouts") and show a clear, specific chat message stating
why, via `addInfoMessage()` (not a generic error). All three thresholds default to `0` (off) —
`0` means "no limit" for each independently, so a normal short chat is unaffected by default.

- **Settings** (`src/settings.ts`, Capabilities tab, "Chat run guardrails"): `loopTurnThreshold`
  (max agent turns), `loopTokenThreshold` (max cumulative tokens: input + output only — see
  **Token threshold** below), `loopCostThresholdUsd` (max dollar cost). Free numeric inputs, not
  the batch-loop launch flow's free-text budget prompt (`parseBudgetInput()`) — these are
  always-on session defaults, not a per-run prompt, so a plain number field fits better than
  parsing `$5`/`5 tokens` strings. Parsed with `Number()` + `Number.isInteger()` (not `parseInt()`,
  which would truncate scientific notation like `1e2` at the `e` and silently floor fractional
  input) — non-integer or out-of-range input is rejected outright rather than saving a value that
  doesn't match what the user typed. `src/budget.ts` (extracted from `batchLoopExecutor.ts` in
  this same change) still backs the batch-loop launch flow's free-text budget; it wasn't reused
  verbatim for these settings-backed thresholds since the input shape differs (persisted numeric
  setting vs. one-off free-text prompt) — see `specs/batch-loops.md`.
- **Run-level counters** (`SynapseView`): `runTurnCount` and `runUsage.totalTokens` are
  distinct from the existing per-*message* `turnStartTime`/`turnUsage` (reset in
  `finalizeStreamingMessage()` after each rendered assistant message). A single `handleSend()`
  call can span several `assistant.turn_start` events (tool-use loops) before `session.idle`, so
  the run-level counters are reset once per `handleSend()` call (before `ensureSession()`), not
  per rendered message. `runAutoCancelled` gates `checkLoopThresholds()` to fire (and call
  `Session.abort()`) at most once per run, and also suppresses the generic error message that
  the abort's consequences would otherwise add on **both** paths that can report it: the
  `session.error` event, and `handleSend()`'s own `catch` block (the pending `send()` call's
  promise rejects once the abort takes effect, and that rejection can surface through either
  path depending on timing). The guardrail's specific reason has already been shown via
  `checkLoopThresholds()`; neither path re-reports it as a second, generic failure.
- **Turn threshold:** checked in `handleSessionEvent()`'s `assistant.turn_start` case, against
  `runTurnCount` (incremented on every turn start for the run) with a strict `>` comparison —
  by the time turn N is observed the model has already completed N turns of work, so `>` lets a
  run finish up to `turnLimit` turns before cancelling on the attempt to start turn `turnLimit +
  1`. (`>=` would cancel immediately on the very first turn for a limit of 1, allowing zero turns
  of actual work — not the intended "allow up to N" semantics.)
- **Token threshold:** checked in the `assistant.usage` case, against `runUsage.totalTokens`
  (accumulated from every `assistant.usage` event's `inputTokens`/`outputTokens` for the run) —
  real-time, since `assistant.usage` streams mid-run, one event per turn. **Input + output only:**
  `assistant.usage` (dispatched in `agentService.ts`) never carries cache-token fields — those are
  only available on the terminal `result` message alongside `total_cost_usd` (see **Dollar
  threshold** below) — so a threshold based on cache usage isn't achievable in real time without
  the same "cost only known after the run" limitation. The counter and the settings copy both
  reflect input+output only rather than implying cache tokens are tracked.
- **Dollar threshold — informational only, not real-time cancellation:** the Agent SDK only
  reports `total_cost_usd` on the terminal `result` message of a `send()` call (see
  `agent-service.md` "Run cost reporting"), i.e. after every turn of that run has already
  executed — there is nothing left to abort by the time the cost is known. Rather than fake a
  per-turn cost estimate, `loopCostThresholdUsd` is checked in the new `assistant.run_result`
  event handler: if the run's actual cost meets or exceeds the threshold, an info message
  reports the cost and explains it couldn't be stopped in-flight, pointing at the turn/token
  limits for real-time enforcement. This is a deliberate, documented limitation, not a bug —
  see `agent-service.md`'s invariant against fabricated cost estimates.

## Search panel

Both modes send a shared prompt (`buildSearchPrompt()`) that instructs tool-driven exploration
(Glob/Grep/Read) and strict JSON-array output (`file`/`folder`/`reason`), rendered by
`renderSearchResults()` (clickable file rows; raw text fallback when the response isn't JSON).
Both modes are **read-only**: `tools: ['Read', 'Glob', 'Grep']` (`SEARCH_TOOLS`) — no write or
exec tools regardless of the tool-approval setting.

- **Basic** (`handleBasicSearch`): one-shot `inlineChat` with the feature/search agent,
  `permissionMode: 'default'`, `maxTurns: 20`, adaptive timeout. (Historic bug: `tools: []` +
  `maxTurns: 1` + `permissionMode: 'plan'` made every search fail with "Reached maximum number
  of turns (1)" — a search config must always include the read tools and a multi-turn budget.)
- **Advanced** (`handleAdvancedSearch` + `buildSearchSessionConfig`): adds the selected search
  agent, model, vault plugins, and enabled skills (the `skills` option enables the Skill tool
  itself), `maxTurns: 40`, and the resilience/self-improve blocks appended to the
  `claude_code` preset. The resulting session is named `[search] <Agent>: <query>` and added
  to the sidebar (skipped when the query aborted without an id).

## Error handling

`session.error` events and `handleSend()` catch blocks pass raw errors through
`formatErrorForChat()` (`synapseView.ts`), which currently just strips a leading `Error: `
prefix. (The pre-engine-swap Ollama-specific `friendlyOllamaError()` pattern-matcher in
`src/ollamaErrors.ts` — connection refused, model not found, OOM, etc. — was removed when the
plugin moved off the Copilot SDK/BYOK-only model and has not been reinstated; `providerPreset`
still exists for BYOK local-provider routing in `providerModels.ts`, but chat error display is
no longer preset-gated.)

### Write/edit tool error guidance (issue #78)

Native `Write`/`Edit`/`NotebookEdit` tool calls are executed by the `claude` CLI subprocess —
the plugin has no custom tool implementation to intercept or retry them. Two complementary
mechanisms handle failures:

- **Display:** `tool.execution_complete` events with an error (see `agent-service.md`) are
  checked by `friendlyWriteToolError()` (`src/toolErrors.ts`). For a Write/Edit/NotebookEdit
  failure whose message matches a transient-looking signature (`EBUSY`, `EPERM`, `EACCES`,
  "resource busy or locked", "being used by another process", "permission denied", "locked"),
  it returns an actionable message (e.g. suggesting the file may be locked by sync or open
  elsewhere) shown via `addInfoMessage()`, in addition to the raw error already shown in the
  collapsed tool-call block. `ENOENT` (no such file or directory) is deliberately excluded —
  it's a bad-path logical error, not a transient lock, so it falls through to the existing
  raw-error display along with other non-write-tool and non-transient errors.
- **Retry-once + ask-before-fabricating:** since the plugin can't programmatically retry a
  native tool call, the behavior is instructed via a `[Resilience]` system-prompt block
  (`buildResilienceHint()`, `sessionConfig.ts`) appended in `buildSessionConfig()` alongside the
  `[Workspace Path Information]` / `[Self-Improve]` blocks. It tells the agent to retry a failed
  write/edit once, then stop and ask the user (rather than silently abandoning the task or
  claiming success) if it fails again — and to confirm it actually read a referenced
  attachment/file (via a tool result) before acting on its content, stopping to ask for
  clarification or re-attachment instead of proceeding with guessed/fabricated content if a
  referenced file can't be found or read.
