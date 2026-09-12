# Thermo-Nuclear Code Quality Audit — 2026-09-12

Scope: whole `src/` tree on `main` (9074efc). Working tree clean; this is a standing-structure
audit, not a diff review. Method: read every file over ~500 lines in full, plus the smaller
modules, and applied the thermo-nuclear bar (structural simplification, file-size, spaghetti,
boundary/type cleanliness, canonical-layer placement).

Verdict: **REQUEST_CHANGES.** The codebase is in a healthy *direction* (the composition
refactor, the typed `SessionEvents` map, `INLINE_CHAT_PROFILES`, and the `matchModelTiers`
consolidation are all real wins), but it has crossed a structural threshold: two files are
well past 1k lines, one more is at the line, and the single most valuable refactor — making
the background-session model own its own state instead of mirroring the view's — has not been
attempted. The findings below are ordered by severity.

---

## 1. `agentService.ts` is 1883 lines and has become a dumping ground (BLOCKER)

The architecture rule says "all SDK access goes through the single service in
`src/agentService.ts`" — and that rule has been interpreted as "put everything SDK-adjacent
in one file." The result is a file that now holds, in one place:

- Two Electron compatibility shims (`setMaxListeners`, refcounted `setTimeout`) — ~120 lines of
  global-mutation code with heavy comments.
- The `ModelInfo`/`mapSdkModel`/`matchModelTiers` model layer.
- Permission helpers (`sessionScopePermissions`, `permissionRuleToString`,
  `extractAllowRuleStrings`, `buildInMemoryPermissionSettings`, `mergeVaultSettingsLayer`).
- The delegation MCP server (`getDelegationMcpServer` with two inline `tool()` definitions).
- The `Session` class (~500 lines: `send`, `abort`, `dispatch`, `convertToSessionEvent`, the
  `SessionEvents` map, `QueryMetadataCache`).
- Task-plan parsing (`parseTodoWritePayload`, `parseTaskCreateInput`, `parseTaskCreateResultId`,
  `parseTaskUpdateInput`).
- `sendAndWaitWithAbort`, `refreshQueryMetadataCache`, `autoApproveReadOnlyTools`.

This is not one concept; it is five or six. The "single entry point" rule was about *SDK type
re-exports* (so no other file imports `@anthropic-ai/claude-agent-sdk` directly) — it was never
meant to mean "one file." The re-export block at the top already satisfies that rule; the rest
of the file can and should be split without touching it.

**Code-judo move:** extract the `Session` class + `SessionEvents` map + `SessionEvent` union +
`QueryMetadataCache` + `refreshQueryMetadataCache` into `src/session.ts` (or `src/session/`).
Extract the two Electron shims into `src/sdkShims.ts`. Extract the permission helpers into
`src/permissions.ts`. `agentService.ts` then shrinks to the `AgentService` class, the model
layer, and the re-exports — roughly 700 lines, all one concept. The re-export surface stays
identical, so no consumer changes.

This is the single highest-leverage change in the codebase. It deletes no behavior and removes
~1000 lines of incidental co-location.

## 2. `synapseView.ts` is 1324 lines and still owns too much (BLOCKER)

The composition refactor extracted `search`, `sidebar`, `configToolbar`, `renderer`, and
`inputArea` — but the view still holds:

- Every shared state field (~150 lines of `messages`, `sessionToolGrants`, `lastSupported*`,
  `currentSession`, `activeSessions`, `sessionList`, `sessionNames`, task-plan maps, streaming
  state, DOM refs).
- `handleSend()` (~200 lines: attachment snapshotting, image-embed resolution, blob
  materialization, turn-context building, the "Session not found" retry).
- `handleSessionEvent()` — a ~250-line `switch` over 14 event types, including the entire
  TodoWrite/TaskCreate/TaskUpdate task-plan state machine.
- `buildSessionConfig()` with the inline `permissionHandler` closure.
- `ensureSession()`, `newConversation()`, `disconnectAllSessions()`, `registerSessionEvents()`.

The controllers were extracted, but the *state* and the *event dispatch* were left behind, so
the view is still the god-object. The `ViewContext` bridge (see §5) is the symptom: every
controller reaches back into `this.view.view.<field>` for the state it was supposedly given
ownership of.

**Code-judo move:** the task-plan state machine is the cleanest first cut. `handleSessionEvent`'s
`tool.execution_start`/`tool.execution_complete` cases and `sessionSidebar.ts`'s
`registerBackgroundEvents` contain *the same* TodoWrite/TaskCreate/TaskUpdate parsing and
`taskPlan`/`pendingTaskCreates` mutation, copy-pasted (see §3). Extract a `TaskPlanTracker`
class (or pure reducer) that owns `taskPlan`, `pendingTaskCreates`, `currentTodos`, and exposes
`onToolStart(toolName, toolCallId, input)` / `onToolComplete(toolCallId, toolName, success,
result, error)` returning a "render needed" flag. Both the foreground and background paths
delegate to it, and the duplicated ~80 lines disappear.

## 3. Task-plan + usage logic is copy-pasted between foreground and background (BLOCKER)

`synapseView.ts#handleSessionEvent` and `sessionSidebar.ts#registerBackgroundEvents` both
contain, nearly verbatim:

- The `TodoWrite` → `parseTodoWritePayload` → `currentTodos` branch.
- The `TaskCreate` → `parseTaskCreateInput` → `pendingTaskCreates.set` branch.
- The `TaskUpdate` → `parseTaskUpdateInput` → `hasVisibleChange` guard → `taskPlan` mutation
  (including the `status === 'deleted'` delete and the `{content, status, activeForm}` merge).
- The `tool.execution_complete` → `TaskCreate` result-id extraction → `taskPlan.set` branch.
- The `assistant.usage` accumulation (input+output, cache fields pinned to 0, `model` overwrite).

This is the textbook "repeated conditionals that signal a missing model" from the skill. The
two copies have already drifted in subtle ways (the background path's `hasVisibleChange`
computation is written differently from the foreground's, and the background path does no DOM
work but still recomputes the same guard). A single `TaskPlanTracker` (or a pure
`applyTaskToolEvent(state, event)` reducer) removes both copies and makes the drift impossible.

## 4. `BackgroundSession` mirrors the entire view state (BLOCKER — code-judo)

`src/view/types.ts#BackgroundSession` is a ~30-field bag that is a 1:1 snapshot of
`SynapseView`'s mutable state: `messages`, `sessionToolGrants`, `isStreaming`,
`streamingContent`, `streamingReasoning`, `reasoningComplete`, `savedDom`, `turnStartTime`,
`turnToolsUsed`, `turnUsage`, `activeToolCalls`, `streamingComponent`, `streamingBodyEl`,
`streamingWrapperEl`, `toolCallsContainer`, `reasoningEl`, `reasoningBodyEl`, `currentTodos`,
`taskPanelEl`, `taskPlan`, `pendingTaskCreates`.

`saveCurrentToBackground()` copies all of them out; `restoreFromBackground()` copies all of them
back. This is a "serialize the whole view" anti-pattern: the background session is not a
first-class object with its own lifecycle, it is a frozen copy of the foreground view. Every
new piece of view state must be added to `BackgroundSession`, `saveCurrentToBackground`, and
`restoreFromBackground` in lockstep — which is exactly the kind of incidental coupling that
silently breaks (a field forgotten in one of the three places).

**Code-judo move:** make the background session own its state. A `BackgroundSession` should hold
a `Session`, its own `messages`, its own task-plan tracker, and its own streaming accumulator —
and expose `onEvent`/`render` methods — rather than being a struct the view fills and drains.
The `savedDom` DocumentFragment trick (moving live DOM nodes in and out of the container) is
the root of the mirroring: it forces the view to hand over every DOM ref. Replacing it with
"re-render from `messages` on restore" (which `restoreFromBackground` already does for the
non-streaming case) would let the background session drop ~15 of its 30 fields.

This is the most ambitious finding and the one with the largest payoff, but it is also the
largest change — flag it as a follow-up issue rather than bundling it with §1–§3.

## 5. `ViewContext` is a "narrow bridge" that isn't narrow (BLOCKER)

`src/view/types.ts#ViewContext` declares itself a "narrow bridge" but exposes
`readonly view: SynapseView` — the *entire* view — and every controller then reaches
`this.view.view.<field>` for shared state. The controllers also re-declare private accessors
(`private get messages() { return this.view.view.messages }`, `private get inputEl() { return
this.view.view.inputEl }`, etc.) purely so the historical `this.<name>` spellings keep
compiling.

This is a thin-wrapper / identity-abstraction smell (skill rule 4): the accessors add
indirection without buying clarity, and the "narrow" interface is actually the widest possible
one. Two honest options:

- **Either** widen `ViewContext` to actually declare the shared state fields the controllers
  read (`messages`, `attachments`, `activeNotePath`, `activeSelection`, `scopePaths`,
  `selectedAgent`, `selectedModel`, `enabledSkills`, `workingDir`, `configDirty`, …) and have
  controllers read `this.view.<field>` directly — deleting the per-controller accessor blocks.
- **Or** move the state onto the controllers that own it (the real fix), so `ViewContext`
  shrinks to `app`/`plugin`/`chatContainer` and a handful of cross-cutting methods.

The current middle ground — a "narrow" interface that leaks the whole view, plus accessor
shims to paper over it — is the worst of both. Note the comment in `sessionSidebar.ts` that a
test asserts the exact substring `this.messages.length`; that test is a symptom of the
accessor-shim approach and should be updated rather than treated as a constraint.

## 6. `sessionSidebar.ts` is 1047 lines and has a dead sort branch (BLOCKER)

`sortSessionList()` has three cases, and `modified` and `created` are **byte-for-byte
identical** — both sort by `lastModified` descending. `SessionMetadata` has no `createdAt`
field that differs from `lastModified` (the cold-load path even falls back
`sessionMeta?.createdAt ?? sessionMeta?.lastModified`), so the "Created date" sort option is a
lie: it produces the same order as "Modified date." Either add a real `createdAt` to the
metadata, or drop the `created` sort option and its menu entry. Shipping a sort control that
silently does nothing is a correctness bug, not a nit.

Beyond that, the file is over 1k and mixes three concerns: sidebar DOM, session
save/restore/background lifecycle, and cold-load transcript replay (`selectSession`'s
`getSessionMessages` loop with `extractMessageText`/`extractAssistantContent`/
`isSyntheticWrapperText`). The transcript-replay helpers at the top are pure and testable and
belong in their own module (`src/view/transcriptReplay.ts`), which would also make them
unit-testable without a DOM.

## 7. `editorMenu.ts` is 995 lines of near-duplicate modal scaffolding (BLOCKER)

Five functions — `showNewNoteModal`, `showNewCanvasModal`, `showAskAboutImageModal`,
`showEditNoteModal`, `showStructureModal` — are the same ~25-line shape: build a `Modal`, add a
description `<p>`, add a `TextComponent`, add a go/cancel button row, wire Enter via
`modal.scope.register`, open, focus. Only the title, placeholder, description, and the go
callback differ. This is copy-pasted scaffolding that should be one
`promptModal({title, description, placeholder, onSubmit})` helper.

Also duplicated in the same file:

- `uniqueFileName` and `uniqueNoteName` differ only by the extension filter (`c.extension ===
  extension` vs `=== 'md'`). One `uniqueName(folder, stem, extension)` covers both.
- The Electron `webUtils.getPathForFile` fallback chain is written out twice
  (`handleAttachFile` and `handleFileDrop` in `inputArea.ts`, plus the same pattern in
  `editorMenu.ts`). One `resolveFilePath(file)` helper.
- The `(view as unknown as {editor?: {cm?: EditorView}}).editor?.cm` cast appears in
  `main.ts` (three times), `editorMenu.ts` (three times), and `inputArea.ts`. This is a
  repeated cast that should be a single `getCmView(view)` helper — and it is exactly the kind
  of `unknown`-cast churn the skill flags (rule 5).

## 8. `settings.ts` (849 lines) — sample content and a hand-rolled YAML parser (MAJOR)

- `SAMPLE_SKILL_CONTENT`, `SAMPLE_GENERAL_AGENT`, `SAMPLE_VISION_AGENT`,
  `SAMPLE_ZETTELKASTEN_AGENT`, `SAMPLE_PARA_AGENT`, `SAMPLE_LYT_AGENT` are ~120 lines of
  inline template strings in the settings module. They are data, not settings logic, and belong
  in a `src/samples.ts` (or a `samples/` folder) so the settings tab stays about settings.
- `configWriter.ts#parseFrontmatter` is a hand-rolled YAML-ish parser (line-by-line `indexOf(':')`,
  quote stripping, list-item detection). It is fragile by construction and already carries a
  comment about a subtle backslash-escaping bug it had to fix. Obsidian ships a YAML parser
  (`obsidian.parseYaml`); if that is insufficient for the list/quote cases here, the parser
  should at least be isolated and unit-tested rather than inline in `configWriter`. This is a
  "generic magic handling that hides simple structure" smell.

## 9. `main.ts` — repeated CM6 cast and a `getEditorView` that duplicates it (MINOR)

`main.ts` defines a local `getEditorView()` helper, then *also* inlines the same
`(view as unknown as {editor?: {cm?: EditorView}}).editor?.cm` cast in three `editorCallback`
bodies. The helper exists but isn't used by the callbacks that need it. Consolidate on the
helper (shared with `editorMenu.ts` per §7).

## 10. `sessionConfig.ts#buildPrompt` — six sequential filter loops (MINOR)

`buildPrompt` runs six separate `attachments.filter(a => a.type === …)` passes (file/image,
directory, clipboard, blob, selection) plus a cursor-position append, each concatenating onto
`prompt`. It is correct and readable, but a single pass over `attachments` with a `switch` on
`att.type` would be both clearer and cheaper, and would make the "which attachment kinds are
inlined how" decision live in one place. Not urgent; flag alongside the larger splits.

---

## What is good (do not regress these)

- **The composition refactor direction** (`search`/`sidebar`/`configToolbar`/`renderer`/
  `inputArea` controllers) is the right instinct — it just stopped halfway (state and event
  dispatch stayed on the view).
- **`SessionEvents` typed map + `SessionEvent` discriminated union + generic `dispatch<K>`**
  is a genuinely good type-boundary design; the "unlisted event is a compile error" property is
  exactly the kind of explicit contract the skill wants.
- **`INLINE_CHAT_PROFILES`** (named presets, caller-explicit-wins) replaced convention comments
  with a typed model — a clean code-judo move already done.
- **`matchModelTiers` / `resolveModelForAgent` / `stripErrorPrefix` / `registerInlineSession`**
  consolidations (audit rec 4) removed real duplication.
- **`telegramApi.ts` seam + fake-adapter tests (#233/#235)** is a clean DI boundary.

## Recommended sequencing

1. **Split `agentService.ts`** (§1) — pure extraction, no behavior change, biggest line-count
   win, unblocks everything else.
2. **Extract `TaskPlanTracker`** (§3) — deletes the foreground/background copy-paste.
3. **Fix the dead `created` sort** (§6) — one-line correctness bug.
4. **Dedupe `editorMenu.ts` modal scaffolding + `uniqueName` + `getCmView`** (§7).
5. **Move sample content out of `settings.ts`** (§8).
6. **Background-session state ownership** (§4) — the ambitious follow-up; file as its own issue.

Items 1–5 are individually small, behavior-preserving, and each removes a category of
incidental complexity. Item 6 is the structural payoff but should not be bundled with the
mechanical splits.
