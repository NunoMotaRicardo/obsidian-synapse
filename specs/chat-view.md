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
  **BYOK local provider caveat:** `executeLocalProviderQuery()` (`providerModels.ts`) sends
  the (now path-inlined) prompt as plain OpenAI-compatible chat-completion text — there is no
  agentic `Read` tool on that path, so a local model only sees the attachment's path as text,
  not its actual image content. True multimodal support there needs OpenAI-compatible
  `image_url` content parts (base64) and is an explicit follow-up, not covered by this fix.
- Sessions are auto-named `<Agent>: <first message>`; trigger/search sessions are tagged.

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
