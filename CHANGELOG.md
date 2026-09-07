# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
