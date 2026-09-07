# chat-view

Source: `src/synapseView.ts` (panel shell, session orchestration), `src/toolErrors.ts`
(friendly write/edit tool error formatting), plus `src/view/*`:

| File | Role |
|---|---|
| `configToolbar.ts` | Agent / model / reasoning-effort / tools / working-dir / debug controls, context-window gauge |
| `inputArea.ts` | Message input, slash-command skill popup, attachments, vault scope button |
| `chatRenderer.ts` | Markdown rendering of messages, reasoning blocks, tool-call details, task/plan tracking panel |
| `sessionSidebar.ts` | Session list, restore (cold resume replays transcript via `AgentService.getSessionMessages()`), rename/delete, background sessions |
| `searchPanel.ts` | AI vault search tab (basic/advanced) |
| `sessionConfig.ts` | Builds `SessionConfig` from selected agent/skills/tools/settings |

Modals (`src/modals/*`): tool approval, elicitation forms, user input (ask_user), ask-user-question
(`AskUserQuestion` tool), edit modal, vault scope, folder tree.

## Behavior contracts

- **Session event wiring is compiler-checked (issue #179):** `registerSessionEvents()`
  (`synapseView.ts`) and `registerBackgroundEvents()` (`sessionSidebar.ts`) both register against
  `AgentService`'s `SessionEvents` map — an unknown event name or a handler expecting the wrong
  payload shape is a build error, not a runtime silent-drop. `registerSessionEvents()`'s handlers
  wrap `Session.on()`'s bare, per-event-typed `data` back into the `{type, data}` shape
  `handleSessionEvent()` switches on (shared with the early-event-buffer replay); this is the only
  place `SessionEvent` (the wrapped union) still appears on the view side.
  `test/sessionEventWiring.test.ts`, the former source-text guard for this, was deleted in the
  same change — the compiler now owns the contract it checked. See "Session event map" in
  `agent-service.md`.
- **View-injection wiring is source-guarded, not compiler-checked (issue #180):** each
  `src/view/*.ts` file injects its methods into `SynapseView` via declaration merging
  (`declare module '../synapseView' { interface SynapseView { ... } }`) plus a prototype
  assignment inside an exported `installX(ViewClass)` function called from the bottom of
  `synapseView.ts`. Because the assignment target is cast to `SynapseView`, the compiler catches
  an undeclared name or a signature mismatch, but not (a) a method declared with no matching
  `proto.<name> =` assignment — the call site compiles clean and throws "is not a function" at
  runtime — or (b) a view file whose `installX(SynapseView)` call is missing from
  `synapseView.ts`, so none of its methods ever attach. Unlike the session-event seam above, this
  gap has no compiler-checked replacement (that would require converting the injection pattern to
  real composition — tracked separately, #176 — not done here). `test/viewInjectionWiring.test.ts`
  reads `src/view/*.ts` and `src/synapseView.ts` as text and asserts both invariants: every
  declared method has a same-file `proto.` assignment, and every exported `install*` has a call in
  `synapseView.ts`. Files are discovered from disk, so a sixth view file is covered automatically.
- **Slash-command skill invocation (issue #91):** the Claude Agent SDK natively recognizes and
  invokes registered skills whenever a literal `/skillname` appears anywhere in the prompt text
  (mid-sentence or not), for every skill loaded into the session — no plugin-side parsing,
  stripping, or invocation routing is involved; the prompt text is sent to the SDK unmodified. All
  discovered vault skills (`_synapse/skills/*/SKILL.md`, scanned by `scanSkills()` in
  `configWriter.ts`) are always loaded for every session (`buildSessionConfig()` in
  `synapseView.ts` passes `skills: Array.from(this.enabledSkills)`, and `enabledSkills` defaults to
  every discovered skill name). The only thing that narrows the loaded set is an explicit
  `skills:` restriction in the selected agent's frontmatter (`AgentConfig.skills` — `undefined` =
  all, `[]` = none, `[...]` = only those listed; applied by `applyAgentToolsAndSkills()` in
  `configToolbar.ts`, whenever the agent selection changes). There is no manual per-session
  toggle — the old toolbar "Skills" checkbox menu was removed, since it's redundant with (and
  overridden by) whatever a `/name` mention in the prompt actually invokes; removing it also means
  invoking a skill via `/name` never needs to mark `configDirty` or force a new session, since the
  effective skill list no longer changes turn-to-turn from user action.
  - **Discovery popup** (`inputArea.ts`): typing `/` in the chat textarea, when preceded by
    start-of-message or whitespace (so `and/or`, `3/4`, `path/to/x` never trigger it), opens a
    small inline dropdown anchored above the textarea (`.synapse-skill-popup`, a plain absolutely
    positioned div, not a modal) listing vault skills whose name prefix-matches everything typed
    since the `/` (case-insensitive). Up/Down arrows move the highlighted row; Tab or Enter
    completes the highlighted skill's name into the textarea (inserting `/name ` and closing the
    popup) without sending the message — the normal Enter-to-send handling is suppressed while the
    popup is open. Escape closes the popup outright; Space closes it too but is not consumed (it's
    still typed normally), since a trailing space after the name is the natural way to end a
    `/name` mention. Selecting a match only ever inserts text — it never sends the message and
    never strips the `/name` token afterward, since the SDK needs to see the literal text to
    invoke the skill.
  - **Search tab (issue #96):** `searchPanel.ts` mirrors the same always-loaded model —
    `buildSearchSessionConfig()` passes `skills: Array.from(this.searchEnabledSkills)`, and
    `searchEnabledSkills` defaults to every discovered skill name, narrowed only by the selected
    search agent's `skills:` frontmatter restriction via `applySearchAgentToolsAndSkills()` (same
    `undefined`/`[]`/`[...]` semantics as `applyAgentToolsAndSkills()`). There is no manual
    per-skill toggle in the search toolbar either. Unlike chat, search never had a slash-command
    popup, so there was no discoverability gap the toggle was compensating for; search is also a
    one-shot `inlineChat()` per query rather than a persistent multi-turn session, so there's no
    `configDirty`/session-continuity motivation for keeping a toggle. Removing it here is purely a
    consistency fix with the chat tab, not a response to either of those specific gaps.
- Streaming: `buildSessionConfig()` sets `includePartialMessages: true` (issue #103), so the chat
  panel — and only the chat panel; search/Telegram/batch loops stay one-shot — gets
  genuine token-level `assistant.message_delta`/`assistant.reasoning_delta` events as the model
  generates, not one lump per turn. The renderer doesn't care which mode produced a given delta:
  `appendDelta()`/`appendReasoningDelta()` just accumulate whatever arrives into
  `streamingContent`/`streamingReasoning` (see "Turn/session-switch lifecycle" below), and the
  final `assistant.message` event only overwrites `streamingContent` if it differs from what
  streamed — a no-op when the accumulated deltas already equal the complete text, so a turn is
  never rendered twice. See `agent-service.md`'s "Partial message streaming" for the
  `Session.convertToSessionEvent()` mapping and why the double-render can't happen.
- **Waiting/thinking indicator (issue #99):** the `.synapse-thinking` dot-animation (built by the
  shared `createThinkingIndicator()` helper in `chatRenderer.ts`) is honest about what state the
  turn is actually in — it never claims "Thinking" unless a reasoning block is actually
  streaming. Partial-message streaming (#103) makes this signal more accurate, not less: the
  first `assistant.reasoning_delta` now arrives from a real `thinking_delta` stream chunk as
  reasoning is actually being generated, rather than from a `thinking` block that had already
  finished generating by the time the complete `assistant` message showed up.
  - `addAssistantPlaceholder()` paints it with "Waiting for response…" immediately after send,
    before any content (reasoning or answer) has arrived.
  - The first `assistant.reasoning_delta` (`appendReasoningDelta` → `startReasoningBlock`) removes
    that placeholder and inserts the `<details class="synapse-reasoning">` block instead, whose own
    summary reads "Thinking…" with a spinner while open — that is the only place "Thinking" copy
    appears, and only while reasoning is actually streaming.
  - `showProcessingIndicator()` reuses the same helper with "Processing" while tool calls run
    mid-turn; `appendDelta()` removes it once answer text starts streaming.
  - `finalizeReasoning()` (called once a reasoning block completes) re-shows the "Waiting for
    response…" indicator in the answer body if no answer text has arrived yet — never "Thinking",
    since reasoning is done at that point.
  - `startReasoningBlock()`'s guard (`streamingWrapperEl`/`streamingBodyEl` missing, e.g. the turn
    was already finalized/torn down when a stray reasoning delta arrives) still returns early
    without rendering, but now emits a `debugTrace` so silently-dropped reasoning is diagnosable
    instead of just accumulating invisibly in `streamingReasoning`.
- Reasoning menu (brain icon) shows only when the selected model reports
  `capabilities.supports.reasoningEffort` and a non-empty `supportedReasoningEfforts`; an
  unsupported persisted level resets to `''`.
  - Effort levels are iterated from `supportedReasoningEfforts` and stored as a free string
    (`settings.reasoningEffort`), because models report values beyond the SDK's
    `ReasoningEffort` union (e.g. `max`, `none`). `none` is labelled "Off"; `''` = model
    default. Re-selecting the active level toggles back to `''`.
  - (issue #106) The menu previously also offered a **Reasoning summary** submenu
    (`settings.reasoningSummary`) and a **Long context** toggle (`settings.contextTier`).
    Both were pre-Agent-SDK controls that were never actually passed to `query()` — they
    persisted a setting and updated the badge, but had zero effect on the session. They were
    removed rather than wired up: the Agent SDK's long-context equivalent is already covered by
    picking a `[1m]` model id from the existing model list (`sdkModelId()` in `agentService.ts`
    surfaces e.g. `sonnet[1m]`), and nothing depended on a reasoning-summary display mode. The
    settings keys (`contextTier`, `reasoningSummary`) are intentionally left off `SynapseSettings`
    but tolerated on load — existing `data.json` files carrying the stale keys still load via the
    `Object.assign({}, DEFAULT_SETTINGS, raw)` merge in `main.ts#loadSettings`; the keys ride along
    as harmless untyped properties on the in-memory settings object and are silently dropped from
    subsequent saves (they're not part of the typed shape written back out).
  - An **Infinite sessions** toggle in the same model-icon menu controls the SDK's
    auto-compaction behavior (`settings.infiniteSessionsEnabled`, default `true` — the SDK
    default). When enabled, the SDK compacts the conversation at ~80% context utilization
    (background) and blocks at ~95% (buffer exhaustion). When disabled, sessions hit the
    context limit and stop. The toggle is always shown (even for models that don't support
    reasoning effort, so the model icon stays interactive), sets a persisted setting, marks
    config dirty, and is omitted from session config when `true` (matching the SDK default).
    `infiniteSessions: { enabled: false }` is passed only when the user explicitly disables it.
    Planned: issue #5.
- **Task/plan tracking panel** (issue #87): Claude Code surfaces its running plan via a tool
  call rather than a dedicated event — either the legacy `TodoWrite` (one call, full plan) or the
  newer `TaskCreate`/`TaskUpdate` (incremental task graph); see `agent-service.md` for why both
  are supported. `handleSessionEvent()`'s `tool.execution_start`/`tool.execution_complete` cases
  branch on `toolName`:
  - `TodoWrite`: parses `data.input` with `parseTodoWritePayload()` (a standalone function
    exported from `agentService.ts`, imported directly — not an `AgentService` method) and, when
    it returns a non-null list, calls `renderTaskPanel(todos)` directly (the call is authoritative
    — it fully replaces prior plan state).
  - `TaskCreate`: `tool.execution_start` parses the input with `parseTaskCreateInput()` and
    stashes `{subject, activeForm}` in a `pendingTaskCreates` map keyed by `toolCallId` (the task
    id isn't known until the result arrives). `tool.execution_complete` extracts the id with
    `parseTaskCreateResultId()`, adds a `{status: 'pending'}` entry to the view's `taskPlan` map
    (`Map<taskId, TodoItem>`), and calls `renderTaskPanel([...taskPlan.values()])`.
  - `TaskUpdate`: `tool.execution_start` parses the input with `parseTaskUpdateInput()` and, if
    `taskId` is already tracked in `taskPlan`, patches that entry (`status: 'deleted'` removes it
    instead) and re-renders — but only when the parsed update actually carries a displayable field
    (`status`/`subject`/`activeForm`). The CLI also emits `TaskUpdate` calls that only touch
    untracked fields (e.g. dependencies); those are absorbed without a map mutation or panel
    rebuild, since nothing shown in the panel would change.
  - A malformed/unrecognized payload for any of these three tool names, or a `TaskUpdate` for an
    untracked `taskId`, falls back to the generic `addToolCallBlock()` rendering rather than being
    silently dropped.
  - `renderTaskPanel(todos)` **replaces** the panel contents on every call — the caller always
    passes the full current plan state (either `TodoWrite`'s payload directly, or the
    view-maintained `taskPlan` map's values for the `TaskCreate`/`TaskUpdate` family) — so there is
    exactly one live `.synapse-task-panel` element per turn (created lazily on the first
    plan-related call, kept as the first child of `toolCallsContainer` so the plan reads above
    per-tool detail blocks). Each task row shows a status icon (pending/in-progress/completed) and
    its label (the in-progress task shows `activeForm` when present, e.g. "Running tests", instead
    of the imperative `content`); the in-progress row is visually distinct (bold, accent-colored
    spinner icon) and completed rows are struck through.
  - The panel header shows a live elapsed-runtime label reusing the existing per-turn
    `turnStartTime` (`chatRenderer.ts` — the same clock the message-metadata footer's clock badge
    reads). A `window.setInterval` (registered via `registerInterval()`, ticking every second)
    refreshes the label while a panel is visible; `finalizeStreamingMessage()` freezes the label
    at its final value and stops the interval (`clearTaskPanelState()`) without removing the
    panel's DOM, so a completed turn's task panel stays visible in history at its last state.
  - No plan for a turn (no `TodoWrite`/`TaskCreate`/`TaskUpdate` call) → `toolCallsContainer`
    never gets a `.synapse-task-panel` child, so nothing renders (the container itself is hidden
    when empty via existing `:empty` CSS).
  - Turn/session-switch lifecycle: `newConversation()` and `finalizeStreamingMessage()` call
    `clearTaskPanelState()` (clears `currentTodos`/`taskPanelEl`/`taskPlan`/`pendingTaskCreates`,
    stops the timer). Background sessions (`sessionSidebar.ts`) carry the same four fields on
    `BackgroundSession`, the same way as `toolCallsContainer`/`activeToolCalls` — the panel's DOM
    travels inside the saved `chatContainer` fragment on `saveCurrentToBackground()` (no separate
    serialization needed), and `restoreFromBackground()` resumes the live-elapsed timer if a panel
    is still showing for an in-progress background turn. A hidden/background session's
    `tool.execution_start`/`tool.execution_complete` handlers mirror the foreground parsing logic
    into `bg.currentTodos`/`bg.taskPlan`/`bg.pendingTaskCreates` (no DOM — the session isn't
    visible) so the latest plan state is available if/when the view re-attaches;
    `session.idle`/`session.error` reset all four for the next turn.
  - **Verified live** (issue #87 deploy-test): the installed CLI (2.1.195) used `TaskCreate`
    (three sub-tasks with a `subject`/`description`/`activeForm`) followed by `TaskUpdate` calls
    (dependency links via `addBlockedBy`, then `status: 'in_progress'` → `'completed'`
    transitions per task) for a multi-step vault-exploration prompt — `TodoWrite` was never
    emitted by that CLI/session. The panel rendered and updated live from the `TaskCreate`/
    `TaskUpdate` path.
- **Message metadata footer (`renderMessageMetadata`)** (issues #88, #178): rendered below completed assistant
  messages with chips for elapsed time (`turnStartTime`), token usage (`turnUsage`), and unique tools used
  (`turnToolsUsed`). Early-returns when none of the three are present. The dead `skill.invoked` event and
  its "skills used" chip were removed in issue #178 because the Claude Agent SDK provides no signal for skill invocation.
- **Compaction events in debug view** (issues #5, #177, #181): when the debug toggle is on,
  the `session.compaction_complete` event renders an inline debug block in the chat
  (same visibility gating as tool calls via `.synapse-hide-debug`). It always renders as
  "Compaction complete" — the SDK only emits `compact_boundary` on success, so there is no
  failure payload to render — and displays pre-compaction tokens, post-compaction tokens,
  tokens removed, duration, and trigger type sourced from SDK `compact_metadata`. Handled in
  `handleSessionEvent()`. Note: `session.compaction_start` was removed in #177 because the SDK
  only emits `compact_boundary` at the compaction boundary without an earlier start event.
- Session restore: resume by id with the full current session config, re-select agent via
  `session.rpc.agent.select`, replay history from `AgentService.getSessionMessages()` (wraps the
  SDK's `getSessionMessages()`, called with no `dir` filter so it searches all project
  directories — sessions are listed unscoped (`loadSessions()` → `listSessions()`), and a
  session's original working directory can differ from the current one since
  `autoUpdateWorkingDirectory` changes it on note switch; scoping to the current `dir` would make
  the lookup miss the session and reproduce an empty backlog). Replay walks each transcript
  message's content blocks for `text` (user/assistant) and `thinking` (assistant); `tool_use`/
  `tool_result` blocks are skipped — tool-call replay is a separate follow-up. An unreadable or
  missing transcript degrades to the welcome screen rather than throwing.
- The active note is attached as context. When `settings.autoUpdateWorkingDirectory` is enabled (default `true`),
  the working directory auto-updates to the active note's parent folder on note switch, applying immediately
  even mid-conversation. When disabled, the working directory is not changed automatically (it defaults to the
  vault root unless overridden manually). The active note's folder can also be overridden manually in the toolbar
  at any time — an auto-update on the next note switch will still overwrite that manual pick, same as before this
  default flipped.
  - **Applies immediately, no longer deferred (issue #108 / #93 / #131):** applying this auto-update
    unconditionally used to force `ensureSession()` (`synapseView.ts`) to tear down the live
    `Session` and rebuild it with an empty `_sessionId` on every folder-crossing note switch —
    the rebuilt `Session`'s very next message silently started a brand-new CLI session with no
    history. Since users switch notes constantly *between* turns, this was the likely root cause
    of #93 ("chat is losing context of the conversation in each turn"), so the change used to be
    deferred until the conversation ended (`SynapseView.pendingWorkingDir`). Issue #104 fixed the
    underlying rebuild to always carry `resume` forward (see the bullet below), removing that
    justification, and issue #131 tested the one other candidate justification — that resuming a
    session under a *changed* `cwd` might degrade the model's handling of paths referenced in
    earlier turns — empirically against a real CLI session and found no degradation: the model
    correctly recalled prior-turn content from context without re-reading, correctly resolved new
    relative references against the new `cwd`, and reported "not found" rather than hallucinating
    when explicitly asked to re-read a stale relative path under the new `cwd`. See
    `.docs/decisions/2026-09-03-cwd-deferral-removed.md`. With no surviving justification, the
    deferral was removed: `updateActiveNote()` (`inputArea.ts`) calls the pure
    `decideWorkingDirAutoUpdate()` (`view/sessionConfig.ts`), which now only checks whether the
    folder actually changed, and applies `workingDir`/`configDirty` immediately when it did. A
    session reset genuinely tied to a *manual* working-directory override
    (`SynapseView.setWorkingDir()`, e.g. dragging a folder onto the input area) is a deliberate
    user action, not a silent side effect of navigation, and is unaffected by this change.
  - **Every `configDirty` rebuild now carries the conversation forward (issue #104):** the
    toolbar-toggle pattern above (agent/model/reasoning/tools) still marks `configDirty` and lets
    `ensureSession()` rebuild the `Session` — that part is unchanged, and deliberately so (see
    `agent-service.md`'s "Carrying a conversation across a rebuilt Session" for why there's no
    live query to mutate instead). What changed is that `ensureSession()` now reads the outgoing
    `Session`'s `sessionId` before tearing it down and seeds the rebuilt `SessionConfig` with it
    (`buildSessionConfig({..., resume})`), so the new `Session`'s first `send()` still resumes the
    prior conversation even though the `Session` object itself is new. Previously any toolbar
    config change silently reset the conversation the same way #108/#93 did for note switches.
  To anchor path resolution, the session is configured with standard system instructions containing
  the absolute vault root, active note path, and working directory, preventing the LLM from constructing
  incorrect absolute paths (e.g., nesting file paths under attached image subfolders).
  All of these blocks are delivered as either part of
  `systemPrompt: {type: 'preset', preset: 'claude_code', append: ...}` — appended to Claude
  Code's default system prompt, never replacing it — or, for volatile content, inlined into the
  per-turn user message instead (see the stable-vs-volatile split below). (A plain-string
  `systemPrompt` replaces the whole default prompt and the model stops using tools/reading
  files; this applies to chat, advanced search, and the Telegram bot alike.)
  **Stable vs. volatile split (issue #201):** the system prompt sits at the front of every
  request, so any change to `systemPrompt.append` invalidates the SDK's cached prefix *and*
  all conversation history behind it — measured at ~50K tokens re-written at cache-write price
  on a turn that changed nothing but the appended block's volatile fields. `buildSessionConfig()`
  (`synapseView.ts`) only ever puts session-stable content in `systemPrompt.append`: the vault
  root, `buildResilienceHint()`, and the static body of `buildSelfImproveHint()` (no longer
  parameterized by agent name). Everything that can change between turns of the same resumed
  conversation — active note, working directory, the `[Vault Structure]` block, and the current
  agent name — is instead built by `buildTurnContextBlock()` (`sessionConfig.ts`) and appended
  to the *user message* on every send (`handleSend()`, after the conversation-history injection),
  where a change only costs that turn's own tokens instead of the whole cached prefix. The
  search and Telegram paths apply the same split (`buildCurrentAgentLine()` inlined into the
  search prompt / Telegram message text) even though their own volatile fields happen to be
  effectively constant in practice — advanced search starts a fresh session per query, and the
  Telegram bot has no active-note concept — so the split costs nothing there but keeps the
  three call sites consistent.
  A compact `[Vault Structure]` block, part of the per-turn context above, lists top-level
  vault folder *names only* — no `(N items)` counts (dropped outright, issue #201, since the
  counts made the block gratuitously volatile without the model needing exact numbers) —
  excluding system folders (`.obsidian`, `.trash`, the synapse folder, and any dot-prefixed
  folder). This gives agents awareness of the vault's organization without reading note
  contents. The scan is performed by `scanVaultStructure()` in `configWriter.ts` (its return
  shape, including `fileCount`, is unchanged — only the formatter stopped emitting it); the
  formatter `buildVaultContextBlock()` lives in `sessionConfig.ts`.
  A compact `[Self-Improve]` detection block is appended to every session's system prompt
  (chat, search, and Telegram bot) via `buildSelfImproveHint()` in `sessionConfig.ts`.
  It teaches the active agent to recognize when the user expresses a customization preference
  and propose creating or modifying a Synapse artifact (agent, prompt, or skill),
  always asking permission before writing. The current agent name is delivered separately,
  per-turn, by `buildCurrentAgentLine()` (see the stable-vs-volatile split above). The whole
  self-improve hint (static body + current-agent line) is skipped when the user is already
  using the `improve-synapse` prompt (no double-activation).
  A compact `[Resilience]` block is appended to every session's system prompt (chat, search,
  and Telegram bot) via `buildResilienceHint()` in `sessionConfig.ts` — retry-once-then-ask
  guidance for failed writes/edits and confirm-before-acting guidance for referenced
  attachments; see "Write/edit tool error guidance (issue #78)" below. This matters most for
  the Telegram bot, which runs unattended with `permissionMode: 'bypassPermissions'` and no UI
  to catch a silent failure — `buildResilienceHint()` stays session-stable and is never moved
  out of `systemPrompt.append`, so this guidance can't be silently dropped by the stable/
  volatile split.
  When `settings.autoIncludeNoteImages` is enabled (default),
  `handleSend()` reads the active note content, scans for image embeds (`![[image.png]]` and
  `![alt](path.png)` syntaxes), resolves them to vault files via `resolveNoteImageEmbeds()`
  (`sessionConfig.ts`), deduplicates against manual attachments, and auto-attaches the first N
  images (capped at `min(settings.maxNoteImages, model.capabilities.limits.vision.max_prompt_images)`)
  as `{type: 'image'}` `ChatAttachment` items. Images beyond the cap are silently skipped.
  The shared `IMAGE_EXTS` constant (`types.ts`) defines the supported image extensions
  (`png, jpg, jpeg, gif, webp, bmp, svg`). Non-vision models are unaffected (the SDK/model
  handles or ignores image attachments gracefully).
- **Tool approval never persists to disk (issue #193).** `buildSessionConfig()`'s `permissionHandler`
  (the `CanUseTool` passed as `canUseTool`) has two branches, and neither writes a
  `.claude/settings.local.json` into the vault or anywhere else:
  - `settings.toolApproval === 'allow'` (auto-allow) returns `{behavior: 'allow', updatedInput:
    input}` with **no** `updatedPermissions` at all — every call is allowed anyway, so echoing the
    CLI's suggested permission updates back would only persist rules that buy nothing.
  - Otherwise, `ToolApprovalModal` opens; its **Allow** button passes the CLI's `suggestions`
    through `sessionScopePermissions()` (`agentService.ts`) before including them as
    `updatedPermissions`, forcing every update's `destination` to `'session'` regardless of what
    the CLI suggested (directory-shaped grants, e.g. an out-of-vault folder attachment, come back
    suggesting `'localSettings'`, which the SDK would otherwise write to `<cwd>/.claude/settings.local.json`
    inside the vault — including drive-wide grants like `Read(//d//**)`). Session scope still keeps
    the approval in effect for the rest of that conversation (no re-prompt loop for the same path)
    without touching disk. See `agent-service.md`'s "Session-scoped permission updates" for the
    helper.
- **A deliberate, permanent grant is back, written by Synapse (issue #197).** #193 removed the CLI's
  own "always allow" persistence outright (it wrote to whatever `<cwd>/.claude/settings.local.json`
  happened to be — the drive-wide `Read(//d//**)` blast-radius problem). #194 gives the vault its own
  settings file Synapse owns, so `ToolApprovalModal` now offers a third action, **Always allow**,
  alongside **Allow** and **Deny**:
  - **Allow** is byte-for-byte #193's behavior — conversation-scoped, writes nothing (AC-2). This is
    unchanged.
  - **Always allow** returns the same `{behavior: 'allow', ...}` `PermissionResult` as **Allow** (so
    the current conversation is granted immediately, same as before) but the modal additionally
    resolves a `persistRules: string[]` alongside it — the rule string(s) (`permissionRuleToString()`'s
    syntax) derived from `extractAllowRuleStrings(request.suggestions)`, or, if the CLI sent no
    `addRules` suggestion to derive one from, a bare `toolName` rule so the button is never a no-op.
    **The modal shows these exact rule strings above the buttons before they can be clicked** — the
    literal text that will be written, not a paraphrase — specifically so a drive-wide suggestion like
    `Read(//d//**)` is visible before the user makes it permanent (the scenario that started #193).
  - The modal itself never writes to disk (it only returns `persistRules`); `buildSessionConfig()`'s
    `permissionHandler` is the one call site that does, via `configWriter.persistToolApprovalRules()`
    (see `config-writer.md`) — matching the `configWriter.ts` file-writing rule in `CLAUDE.md`. A write
    failure (e.g. malformed existing `_synapse/settings.json`) surfaces as a `Notice` but does not
    revoke the in-memory grant already returned to the SDK for the current conversation.
  - There is no in-app UI to remove a persisted grant (AC-5) — `wiki/Customization.md` documents
    editing `_synapse/settings.json`'s `permissions.allow` list directly.
- **In-memory tool-approval grants (issue #193 round 2).** `destination: 'session'` above only
  covers the CLI process handling the *current* turn — the Agent SDK spawns a fresh process on
  every `Session.send()` (resuming by session id), so in **ask** mode the grant above was lost on
  the very next turn, re-prompting for the same path repeatedly. `SynapseView.sessionToolGrants`
  (a `Set<string>` of CLI rule strings, e.g. `Read(C:\path\**)`) fixes this by accumulating
  approved grants for the life of the conversation and re-injecting them into every query via
  `Options.settings` — see `agent-service.md`'s "In-memory tool-approval grants" for the
  `extractAllowRuleStrings()`/`buildInMemoryPermissionSettings()`/`Session.applyToolGrants()` mechanism.
  Nothing is written to disk; the set lives only in memory.
  - `buildSessionConfig()`'s `permissionHandler`, on an `'allow'` result with `addRules`/`'allow'`
    suggestions, adds the extracted rule strings to `sessionToolGrants` and immediately calls
    `this.currentSession?.applyToolGrants(...)` so the *next* `send()` on the same, un-rebuilt
    `Session` object already carries the grant — a session that only picked it up on the next
    `configDirty` rebuild would still re-prompt for every turn in between.
  - `buildSessionConfig()` also seeds a freshly (re)built `Session`'s initial `settings` from
    whatever `sessionToolGrants` already holds, exactly the way `resume` carries the conversation's
    session id across a rebuild (issue #104) — so a rebuild triggered by e.g. a model change never
    drops an already-approved grant.
  - **Cleared only in `newConversation()`** — a genuinely new conversation starts with no known
    grants, which is why AC-3's "starting a new conversation prompts again" holds. It is *not*
    cleared on a `configDirty` rebuild (that would defeat the fix) or on the background-session
    round-trip in `sessionSidebar.ts`: `saveCurrentToBackground()`/`restoreFromBackground()` carry
    a `sessionToolGrants` copy on `BackgroundSession` alongside `sdkSeenIndex`, and `selectSession()`
    resets the view's set to empty before either restoring that copy (same conversation, still
    alive in the background) or cold-loading a persisted session from disk (a different
    conversation this view instance has no in-memory grant history for).
  - Issue #194 layers `_synapse/settings.json` (the vault's own settings) *underneath* whatever
    `sessionToolGrants` produces here, inside `AgentService.routeQueryOptions()` — not a second
    merge point in the view layer. A vault-level `permissions.deny` rule still applies even after
    a grant is added mid-conversation, because the merge happens fresh on every query build; see
    `agent-service.md`'s "Vault settings layer (issue #194)".
- **`AskUserQuestion` gets a dedicated question UI, not the approval gate (issue #182).**
  `buildSessionConfig()`'s `permissionHandler` checks `toolName === 'AskUserQuestion'` **before**
  the `settings.toolApproval === 'allow'` auto-allow short-circuit and before `ToolApprovalModal`
  — verified live against the CLI (`@anthropic-ai/claude-agent-sdk` 0.3.x): `canUseTool` does fire
  for this tool on the Agent SDK path, and allowing it with **no** `answers` (which is what
  auto-allow's `updatedInput: input` passthrough would do) is exactly the bug this fixes — the
  call resolves unanswered and the model falls back to prose instead of a structured question.
  (A bare `AskUserQuestion` entry in `allowedTools` would shadow the `canUseTool` callback
  entirely — the SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — so none is added.)
  - `AskUserQuestionModal` (`src/modals/askUserQuestionModal.ts`, mirroring `ElicitationModal`'s
    promise-resolving structure) renders every question (1-4) with its `header` chip, the question
    text, and each option (2-4) as a selectable card (label + description); `multiSelect: true`
    allows several cards selected at once, `false` allows exactly one. Every question also offers
    an **Other** free-text card — the tool description tells the model the harness supplies one,
    so the model never sends one itself. Submit stays disabled until every question has an answer
    (a selected option or non-empty Other text). The Other field claims the answer on **typed
    text, not on focus** — on a single-select question claiming it clears the selected option, so
    focusing alone would silently drop the user's pick and leave Submit disabled with nothing
    typed to replace it.
  - **The option cards carry their own keyboard semantics.** They are `div`s (so a card can lay out
    a label, description and preview) rather than native inputs, so the modal sets the roles and
    key handling by hand: the options container is a `radiogroup` (single-select) or `group`
    (multi-select) labelled by the question text, each card is a `radio`/`checkbox` with
    `tabindex="0"` and a maintained `aria-checked`, Enter/Space toggles it (both default-prevented
    — Space would scroll, Enter would submit), and the arrow keys move focus within the question's
    cards. The Other option's control is the text input itself, natively focusable, so it takes an
    `aria-label` instead of a role. This is not cosmetic: the modal blocks the agent's turn until
    it is answered or dismissed, so click-only cards would strand a keyboard-driven user.
  - On submit, the pure `buildAskUserQuestionAnswers()` helper (exported standalone, no DOM/Obsidian
    dependency, so it's unit-tested in `test/askUserQuestionModal.test.ts` without a live CLI or
    vault) maps the per-question selection state to the `answers`/`annotations` shape the CLI
    expects: `answers` is keyed by the **question text**, valued by the selected option's
    **label** — for `multiSelect`, the selected labels joined with `", "` (verified live:
    `"Alpha, Gamma"`, in option order); an "Other" answer is the typed string as-is, appended
    **after** the selected labels since it is not one of the listed options.
    `annotations[question].preview` is populated only for a single-select answer whose one
    selected (non-Other) option carries a `preview` — a joined multi-select answer or a free-text
    Other answer has no single option's preview to attach, so annotations are omitted for those.
  - **Selection state is positional, not keyed by question text.** Nothing in the tool's schema
    forbids two questions carrying identical `question` text, so `states` is an array parallel to
    `input.questions` — keying it by text would make both questions share one selection and mirror
    each other in the UI. The CLI's `answers` map *is* keyed by that text and therefore has a
    single slot for both, so on emit their answers merge into it (deduplicated, first annotation
    wins) rather than the later question silently discarding the earlier one's answer.
    The modal resolves `{behavior: 'allow', updatedInput: {...input, answers, annotations}}` (SDK
    result type: `PermissionResult`'s `updatedInput?: Record<string, unknown>`).
  - Dismissing the modal (Esc/close/Cancel button) resolves `{behavior: 'deny', message: 'Denied
    by user'}` rather than hanging or submitting empty answers.
  - This is a question UI, not an approval gate: unlike `ToolApprovalModal`, there is no
    `suggestions`/`persistRules`/`sessionToolGrants` handling for this branch.
  - **Unattended paths still deny it**, with a message explaining no one is available to answer
    rather than the generic wording each site otherwise uses: `autoApproveReadOnlyTools`
    (`agentService.ts`, used by search/local-model call sites) and `makeDenyingCanUseTool`
    (`runExecutor.ts`, used by batch/trigger runs) both special-case `toolName ===
    'AskUserQuestion'` before their normal fallback-deny message.
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
  **BYOK local provider conversation history (issue #135):** same local-model check
  (`isLocalModel()`) additionally builds a `history` payload before `Session.send()` — before this
  fix, the local ReAct loop was fully stateless turn-to-turn (no `resume`, no persisted session,
  every call rebuilt its `messages` array from just the current prompt). `handleSend()` calls
  `buildLocalHistory(this.messages.slice(0, -1), vaultBasePath)` (`sessionConfig.ts`) — the slice
  excludes the current-turn user message `addUserMessage()` already pushed onto `this.messages`
  earlier in the same call, since that turn is sent via `prompt`, not replayed as history — and
  passes the result as `Session.send({history})`. See agent-service.md's "BYOK local provider
  conversation history" section for the full mapping/budget/sizing details (this stays scoped to
  what's specific to the view: where in `handleSend()` history is built and why the slice excludes
  the current turn).
  **Bridging local turns into the SDK session (issue #135's asymmetry, fixed by #137):** #135
  alone only fixed continuity in the direction the plugin controls the payload (local-model
  turns). Switching *back* to a Claude model — or starting a conversation on a local model at all
  — resumed a CLI session with no record of the local turns, since they never reached the CLI.
  `handleSend()`'s non-local branch now computes `computeSdkHistoryGap(this.messages,
  this.sdkSeenIndex)` and, when non-empty, prepends `buildSdkHistoryInjection()`'s delimited
  transcript block to the prompt actually sent to `Session.send()` (`promptForSend`, distinct from
  the clean `fullPrompt` used for local models and for what's stored in `this.messages`).
  `SynapseView.sdkSeenIndex` — the high-water mark of how much of `this.messages` the CLI's
  session already has — advances to `this.messages.length` after every SDK-routed `send()` that
  reaches the CLI without throwing, and is otherwise left alone (including by local-routed turns,
  by `ensureSession()`'s `configDirty` rebuilds, and by a live conversation's ordinary turns). See
  agent-service.md's "Bridging local-provider turns into the SDK session" for the full mechanism,
  the budget rationale (deliberately different from #135's — Claude's context window is far larger
  than a local model's), and why the mark lives on `SynapseView` rather than `Session` (it must
  survive a `configDirty` `Session` rebuild, #104). The mark is reset on `newConversation()`, set
  to "fully seen" on cold session resume (`selectSession()`'s SDK-resume path) since a resumed
  session's replayed messages come straight from the CLI's own transcript, and carried through
  `BackgroundSession` on background-session save/restore.
- Sessions are auto-named `<Agent>: <first message>`; search sessions are tagged.
  A new session's id is unknown until the first send streams a message: `handleSend()` stores
  the first-prompt snippet in `pendingSessionLabel`, and the `session.init` event (dispatched
  by the `Session` wrapper when the SDK delivers the id — see agent-service.md) adopts the id
  into `currentSessionId`, writes the `[chat] <Agent>: <snippet>` name, and adds the sidebar
  entry. Never write a session-name entry keyed by an empty id: `registerInlineSession` (view
  and editor-menu variants), the edit modal, and advanced search all no-op when `sessionId` is
  empty (aborted queries), and `onOpen()` deletes any legacy `''`-keyed entry left by older
  builds.

## Context-window gauge and live command/agent lists (issue #130)

Capture-and-cache — `.docs/decisions/2026-09-04-persistent-query-cache.md`. `Session` (not the
view) owns the cache; `synapseView.ts` only reads it via three getters and reacts to a
`session.metadata` `SessionEvent`. See `agent-service.md`'s "Query metadata cache" for the
`Session`-side mechanism and its one-turn-stale/timing caveats.

- **The gauge** (`.synapse-context-indicator`, built in `configToolbar.ts`'s
  `buildConfigToolbar()`, before the debug-toggle spacer): a small pill reading `"NN% context"`
  with a tooltip giving the raw token counts (`~totalTokens / maxTokens`) and a note that the
  figure is one turn stale. `updateContextIndicator()` reads
  `this.currentSession?.cachedContextUsage` and:
  - **Renders nothing** (`is-hidden`, empty text) when it's `undefined` — before any session has
    captured a value, and for the entire conversation on a BYOK local model (see
    `agent-service.md`: the local-provider branch never touches a `Query` handle, so
    `cachedContextUsage` never becomes defined on that path). Never a placeholder `0%`.
  - Adds `is-context-warning` at ≥75% and `is-context-critical` at ≥90% (percentage from the
    SDK's own `SDKControlGetContextUsageResponse.percentage`, `sdk.d.ts:3586` — not recomputed
    or estimated here).
  - Called from `handleSessionEvent()`'s `'session.metadata'` case (after every capture
    attempt, successful or not), and from every point `currentSession` identity changes —
    `ensureSession()` (a `configDirty` rebuild starts a new `Session` with an empty cache),
    `disconnectSession()`, `newConversation()`, and the sidebar's `restoreFromBackground()`/
    `selectSession()` cold-resume path (`sessionSidebar.ts`) — so the gauge never shows a stale
    session's numbers under a different session's tab.
- **Slash-command popup and agent picker** merge the live cache with the directory scan:
  `getEffectiveSkills()`/`getEffectiveAgents()` (`configToolbar.ts`) return
  `mergeLiveSkills(session.cachedSupportedCommands, this.skills)`/
  `mergeLiveAgents(session.cachedSupportedAgents, this.agents)` (`sessionConfig.ts`) when the
  current session has captured a value, else the unchanged directory-scan result (`this.skills`
  from `scanSkills()`, `this.agents` from `scanAgents()`). A session that has never sent a turn
  has an empty cache, so this transparently falls through to the scan — the pre-#130 behavior
  for that case is unchanged.
  - **The merge rule is: the CLI decides membership, the scan supplies config.** An agent the
    CLI did not load is dropped (the CLI is authoritative about what actually loaded); an agent
    present in both keeps its scanned `AgentConfig`. This matters because `AgentInfo` has no
    `tools`/`skills` and `applyAgentToolsAndSkills()` reads `skills: undefined` as "enable all"
    — replacing a scanned config outright would silently widen a vault agent that had
    deliberately restricted itself. Same rule for skills, so a vault skill keeps its
    `folderPath`.
  - `inputArea.ts`'s slash popup (`updateSkillPopup()`) filters `getEffectiveSkills()` (not
    `this.skills` directly) by `enabledSkills`.
  - `configToolbar.ts`'s `selectAgent()` looks up the chosen name in `getEffectiveAgents()`
    (not `this.agents` directly); `updateConfigUI()` populates the `<select>` from the same.
  - `applyAgentToolsAndSkills()` — the agent-declared `skills:` restriction filter — filters
    `getEffectiveSkills()`, so a CLI-sourced skill list is restricted the same way a
    scan-sourced one is.
  - **Only the gauge refreshes on `session.metadata`.** That event fires once per `assistant`
    message, i.e. repeatedly mid-turn, and `updateConfigUI()` mutates session configuration
    (rebuilds the `<select>`, can reset `selectedAgent`, rewrites `enabledSkills`). The
    agent/skill lists therefore refresh on `session.idle` instead, which is also when a
    one-turn-stale cache is meaningful.
  - The mapping is lossy in one direction: `AgentInfo` (CLI) carries no `skills`/`tools`
    restriction or markdown body, so a CLI-sourced `AgentConfig` entry always has
    `skills: undefined`/`tools: undefined` (= "all enabled", the same default the scan path
    uses for an agent that declares no restriction) and `instructions` falls back to
    `description`. `SlashCommand` (CLI) has no vault folder, so a CLI-sourced `SkillInfo`
    entry's `folderPath` is `''` — never read for those entries, since nothing in the popup or
    picker resolves a folder path for display.

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
  setting vs. one-off free-text prompt) — see `.docs/specs/batch-loops.md`.
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

**Reaches a local model too, as of issue #167.** Both `inlineChat()` calls now also pass
`app: this.app` and `canUseTool: autoApproveReadOnlyTools` (`agentService.ts`). Without these,
`inlineChat()`'s `supportsTools && app && canUseTool` gate (#150) was never satisfied for search,
so a local/BYOK model got the pre-#150 bare one-shot regardless of `SEARCH_TOOLS` — it could not
actually explore the vault, only guess from the prompt text. `autoApproveReadOnlyTools` is an
always-allow `CanUseTool`, safe here specifically because both search call sites restrict `tools`
to the read-only set (`SEARCH_TOOLS`) — see "Wiring `inlineChat()`'s callers (issue #167)" in
`agent-service.md` for the full reasoning (parity with the SDK path's own auto-approval of
read-only tools, and why this is deliberately not #151's unattended `resolveToolApprovalPolicy()`
mechanism). This does not open an approval modal per tool call — up to `maxTurns: 40` of them
would make search unusable — and does not change the Claude-path behavior search already has.

## Error handling

`session.error` events and `handleSend()` catch blocks pass raw errors through
`formatErrorForChat()` (`synapseView.ts`), which currently just strips a leading `Error: `
prefix. (The pre-engine-swap Ollama-specific `friendlyOllamaError()` pattern-matcher in
`src/ollamaErrors.ts` — connection refused, model not found, OOM, etc. — was removed when the
plugin moved to the Agent SDK and has not been reinstated; `providerPreset`
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
