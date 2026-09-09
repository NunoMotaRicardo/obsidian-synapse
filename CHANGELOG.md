# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-09-09

A unified model-execution architecture: all models (Claude and local endpoints) now route through the Claude Agent SDK via the Anthropic Messages API. The legacy hand-rolled ReAct loop, the OpenAI-compatible provider matrix, and the batch-loop feature have been removed in favor of native Agent SDK capabilities.

### Added

- **Local agent endpoint (#122, #222):** Route local models through the real Claude Agent SDK by pointing to Ollama v0.14.0+ (or any Anthropic Messages API-compatible endpoint) at `http://localhost:11434`. Local models now enjoy full Agent SDK support: sessions, skills, streaming, and tool execution instead of a simplified loop.
- **Endpoint Test button in Settings (#223, #224):** Direct `/v1/messages` probe in the Local agent endpoint settings section to verify connectivity and protocol compatibility with immediate feedback.

### Changed

- **Unified single-engine routing:** All model interactions now pass through `AgentService` and the Claude Agent SDK.
- **Composer styling:** Reduced chat composer input font size to 14px for better typographical hierarchy alongside transcript serif styling.

### Removed

- **OpenAI-compatible provider matrix and local ReAct loop (#220, #225):** Removed the generic OpenAI-compatible preset, Azure OpenAI, Foundry Local, and the hand-rolled 5-turn ReAct loop (`executeLocalProviderQuery`), standardizing on the Messages API. Includes a one-time migration Notice for users with legacy provider URLs.
- **Batch-loop feature (#221, #226):** Removed the batch-loop executor, batch loop progress modal, budget tracking, and associated commands and styles, with no replacement.

## [1.5.0] - 2026-09-08

The **Editorial** redesign (#206) transforms Synapse from a chat box into a printed page that lives naturally alongside your notes. Chat bubbles, avatars, badges, and colored pill backgrounds are replaced by intentional typography, hairline rules, and monospace margin rails.

### Added

- **Editorial design language (Variant B) across all surfaces (#206):**
  - **Bundled Newsreader serif:** Assistant responses speak in bundled Latin-subset Newsreader (upright and italic, OFL 1.1) with zero runtime network requests, while the user's voice remains in interface sans (#207).
  - **Ruled transcript:** Letterspaced small-caps speaker labels (`YOU` / `SYNAPSE`) with trailing hairline rules; user turns set in a washed block with a clay left rule (#207).
  - **Tool margin rail (ledger):** Tool calls render down an indented monospace rail as quiet footnotes to the text, pulsing the accent when running and showing completions and denials cleanly (#207).
  - **Ruled page masthead & colophon composer:** The panel header replaces the old tab bar with an editorial page head (serif wordmark, kicker, text tabs); the composer transforms from a floating card into a ruled colophon with serif input and softened context chips (#208).
  - **Ruled session sidebar & search tab:** Session list adopts unlined rows with serif titles and accent left border on active session; search tab mirrors the ruled composer and hairline results (#209).
  - **Config toolbar & context-window gauge:** Upper-case letterspaced controls, hairline meter context gauge, and definition-list task tracking (#210).
  - **Editorial modals:** All plugin modals (tool approval, ask-user-question, elicitation, edit, vault scope, batch progress) restyled with serif titles and ruled forms (#211).
- **Transcript context stripping:** Replaying session transcripts automatically strips internal prompt transport scaffolding (`--- Attached file: ...`, cursor positions, workspace path information) so only genuine user prompts appear in the chat view.

### Changed

- **Stable vs. volatile prompt split (#201):** Vault structure, active note, and working directory are delivered as part of the user message rather than `systemPrompt.append`, preventing cache-invalidation of the entire conversation on note switches and drastically reducing token costs.
- **Working directory auto-update deferral (#202):** Active-note-driven working directory changes are deferred while a conversation is in progress, eliminating unnecessary CLI process restarts and full transcript replay cache churn.
- **Unified single-row composer footer:** Sits debug and send alongside session config controls with softened chips and enclosed scope remove affordances.

## [1.4.0] - 2026-09-07

Highlights of the ~40 pull requests merged since 1.3.0; see the
[full commit range](https://github.com/NunoMotaRicardo/obsidian-synapse/compare/1.3.0...1.4.0)
for everything else.

### Added

- A dedicated modal for the agent's `AskUserQuestion` tool, so structured
  questions are answered in place instead of the model falling back to asking
  in prose. Handles 1-4 questions with single- or multi-select options, adds an
  **Other** free-text option, and is fully keyboard-operable (#182).
- Vault-scoped settings: Synapse now reads and writes `_synapse/settings.json`
  as its own settings layer, which is what makes a deliberate, permanent
  **Always allow** tool grant possible without writing to arbitrary
  `.claude/settings.local.json` files (#194, #197).
- Real token-level streaming of assistant output in the chat panel, via the
  Agent SDK's `includePartialMessages` (#103). One-shot and unattended paths
  (search, Telegram, batch loops) are unaffected.
- A real context-window gauge, plus live command and agent lists, driven by
  captured query metadata (#130).
- Vault tools for BYOK/local models in chat and search, behind the existing
  approval gate, and conversation memory for local-provider chats
  (#150, #167, #136).

### Changed

- Tool approvals no longer leak to disk. An **Allow** is scoped to the
  conversation and writes nothing; grants accumulate in memory so they survive
  the SDK's per-turn process respawn; **Always allow** is the only path that
  persists, into the vault's own settings file, and shows the exact rule
  strings before you commit to them (#193, #197).
- Unattended runs (batch loops, editor actions) share a single tool-approval
  policy, and refusals are reported rather than silently dropped (#151).
- Stopping a chat run asks the CLI to stop gracefully via `Query.interrupt()`
  instead of hard-aborting the subprocess (#116).
- Provider model lookups and local-provider chat calls go through Obsidian's
  `requestUrl()` rather than `fetch()`, avoiding the renderer's CORS sandbox
  for local endpoints such as Ollama (#115).
- Provider presets collapsed to Ollama, OpenAI-compatible and Azure OpenAI,
  with real capability metadata read from provider catalogues instead of being
  guessed from model ids (#125, #132, #134).
- Renamed the **Chat with Synapse** command to **Chat with selection**. The
  command ID and its hotkey are unchanged (#115).

### Removed

- **The trigger runtime, its UI, its configuration surface and its docs
  (#188).** Any triggers you had configured no longer run, and the settings
  that defined them are ignored. Batch loops remain the supported way to run
  Synapse over many notes.

### Fixed

- Frontmatter values no longer corrupt on every edit through double-escaping
  on read (#161).
- Vault skills stay findable and CLI commands stay present across session
  rebuilds (#163).
- Interrupting a chat run no longer throws
  `TypeError: setTimeout(...).unref is not a function` in the developer
  console. This is an upstream Agent SDK bug (an unguarded `.unref()` on its
  subprocess-teardown timers, which Electron renderers do not provide); the
  previous workaround patched `globalThis.setTimeout` for the whole app's
  lifetime and has been replaced (#116).
- The conversation carries across a `configDirty` session rebuild instead of
  being dropped (#133).
- Compaction failures are reported in the UI instead of being swallowed (#177).
- Claude models are no longer misrouted to the degraded local-model path (#124).

## [1.3.0] - 2026-09-02

### Added

- Slash-command popup for invoking skills directly from the chat input (#91).
- CLI/SDK version-skew detection: Synapse now warns when the system `claude`
  CLI and the bundled Claude Agent SDK are from different release trains,
  which is the usual cause of otherwise-inexplicable session failures (#102).

### Changed

- Auto-update working directory now defaults to the active note's parent folder
  instead of the vault root (#94).
- Unified the search tab's model-loading behavior with chat's always-loaded
  model, removing the redundant manual **Skills** toggle from the search panel
  (#96).
- Relicensed the project under the MIT license (#113).
- Upgraded all runtime and development dependencies, including the Claude Agent
  SDK. `@codemirror/state` and `@codemirror/view` are deliberately held at the
  versions Obsidian pins in its peer dependencies (#102).

### Removed

- The **Long context** toggle and the **Reasoning summary** selector, both
  leftovers from the Copilot era that had no effect on the Claude Agent SDK
  session (#106).

### Fixed

- Chat no longer appears empty after switching sessions from the history
  panel — the session transcript is now replayed on cold load instead of
  showing a blank view (#98).
- The waiting/thinking indicator no longer claims "Thinking" when no
  reasoning is actually streaming from the model (#99).
- Changing the working directory mid-conversation no longer silently resets the
  session and loses the conversation's context. The new directory is applied to
  the next conversation instead (#93, #108).


### Added

- Slash-command popup for invoking skills directly from the chat input (#91).

### Changed

- Auto-update working directory now defaults to the active note's parent folder
  instead of the vault root (#94).
- Unified the search tab's model-loading behavior with chat's always-loaded
  model, removing the redundant manual **Skills** toggle from the search panel
  (#96).

### Fixed

- Chat no longer appears empty after switching sessions from the history
  panel — the session transcript is now replayed on cold load instead of
  showing a blank view (#98).
- The waiting/thinking indicator no longer claims "Thinking" when no
  reasoning is actually streaming from the model (#99).
