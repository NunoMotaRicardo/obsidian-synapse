# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Real token-level streaming of assistant output in the chat panel, via the
  Agent SDK's `includePartialMessages` (#103). One-shot and unattended paths
  (search, triggers, Telegram, batch loops) are unaffected.

### Changed

- Stopping a chat run now asks the CLI to stop gracefully via the SDK's
  `Query.interrupt()` instead of hard-aborting the subprocess (#116).
- Provider model lookups and local-provider chat calls now go through
  Obsidian's `requestUrl()` rather than `fetch()`, which avoids the renderer's
  CORS sandbox for local endpoints such as Ollama (#115).
- Renamed the **Chat with Synapse** command to **Chat with selection** to
  distinguish it from **Open chat**. The command ID and its hotkey are
  unchanged (#115).

### Fixed

- Interrupting a chat run no longer throws
  `TypeError: setTimeout(...).unref is not a function` in the developer
  console. This is an upstream Agent SDK bug (an unguarded `.unref()` on its
  subprocess-teardown timers, which Electron renderers do not provide); the
  previous workaround patched `globalThis.setTimeout` for the whole app's
  lifetime and has been replaced (#116).

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
