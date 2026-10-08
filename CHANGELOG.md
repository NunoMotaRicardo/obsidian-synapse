# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-08

### Added

- Right-clicking in the editor now shows a single item: **Edit with Synapse** when text is selected, or **Insert with Synapse** when it isn't. Both open a box where you describe what you want. Synapse reads the whole note for context and applies the result directly; press Ctrl+Z to undo. If the note changes while Synapse is working, the result is copied to your clipboard instead.
- Your instructions can name a skill, for example "rewrite this using my writing-style skill", to rewrite text in your own writing style. Synapse can load skills and read files here, but never changes files itself.
- A new **Edit or insert with Synapse** command in the command palette.

### Changed

- When the API's safety filter blocks a request, the notice now explains why, names the model, and lists what to try, instead of showing the raw error.
- Right-clicking a note in the file explorer now shows only **Chat with Claude Synapse**.

### Removed

- The Synapse editor submenu (Edit, Rewrite, Proofread, Use synonyms, Minor/Major revise, Describe, Answer, Explain, Expand, Summarize) and the multi-choice Edit dialog, replaced by **Edit with Synapse**.
- The commands **Edit selection**, **Edit the note**, **Structure and refine**, and the per-action commands (Rewrite, Proofread, …). If you had hotkeys on them, assign one to **Edit or insert with Synapse**.

## [0.3.1] - 2026-10-05

### Fixed

- The local agent endpoint **Test** button now lists the endpoint's models and reports how many are available, instead of failing with a "model not found" error when a specific model isn't installed.
- The **Replace** button in the Initialize confirmation dialog uses Obsidian's current destructive button style.

## [0.3.0] - 2026-10-05

### Added

- A **Search** agent in the starter kit now carries the vault-search instructions and is the default agent for Semantic search. Run **Initialize** to install it; if another agent runs a search, the instructions are added to the prompt so results still render.
- **Initialize** is now shown on both the Feature Map & Agents and Capabilities settings pages. It can reset the Writer and Search agents and the `obsidian` and `synapse-config` skills to their bundled versions, asking for confirmation on each one separately. Your own agents and skills, `writing-style`, `think`, and `settings.json` are never overwritten.

### Changed

- The Basic/Advanced search toggle tooltips now explain what each mode does and what clicking switches to.

### Fixed

- The search prompt uses the vault's configured config folder instead of a hardcoded `.obsidian`.

## [0.2.4] - 2026-10-03

### Fixed

- Search no longer fails when Claude narrates before or after its answer; the JSON result is now extracted from the reply.
- Search now matches file names as well as file contents.
- Dependency advisories for `moment` and `yaml` are resolved.

## [0.2.3] - 2026-10-02

### Added

- `/model` now runs inside Synapse. With no argument it shows the current model and the concrete model each alias (Default, Sonnet, Opus, …) resolves to; `/model <name>` switches the model picker.

### Fixed

- Slash commands and skills typed in the chat (such as `/model`) failed with `Model '…' not found` because Synapse appended the attached note, cursor position and workspace context to them. They are now sent exactly as typed, and their errors show as short messages.

### Changed

- Updated the Claude Agent SDK and other dependencies.

## [0.2.2] - 2026-09-29

### Added

- Synapse now creates a default `_synapse/settings.json` allowing `Read`, so a new vault can read files without prompting. An existing file is never overwritten.
- The `synapse-config` skill documents the `_synapse/settings.json` permission format, so asking Claude to change permissions edits that file instead of `.claude/settings.json`.
- A link to the companion Claude Synapse theme in settings, the README and the wiki.

### Fixed

- **Always allow** could fail to save a rule when `_synapse/settings.json` existed on disk but Obsidian had not indexed it yet. It now saves, and shows a notice confirming where.

## [0.2.1] - 2026-09-25

### Fixed

- Fixed the settings page layout. Each settings page now shows only its own section, stacked at full width, instead of a duplicate tab bar beside the content that overflowed the dialog. Explanatory text lines up with the setting rows.

## [0.2.0] - 2026-09-25

### Added

- The chat thinking box now shows Claude's reasoning text, in a smaller, compact sans-serif style.
- Debug logging when a vault-local `_synapse/` plugin fails to load.

### Changed

- Upgraded the Claude Agent SDK to 0.3.281. On Claude CLI 2.1.261+, vault plugins are sent during initialization, including on the first message after startup.
- The tool approval modal honors the SDK's `suppressAlwaysAllowRule` and `defaultToNo` hints.
- The cost budget now applies per run on Claude CLI 2.1.277+.

### Fixed

- Restored the plan panel on Opus 5 and Sonnet 5 models.
- Resuming a conversation from the sidebar no longer reports the whole conversation's cost as the cost of the next run.
- Runs that finish while their conversation is in the background now save their cost total.

## [0.1.4] - 2026-09-16

### Changed

- Added GitHub build-provenance attestations for the verified release installer assets.
- Addressed community-directory audit findings in the manifest, settings search, SDK timer compatibility, and scoped UI styles.
- Stopped forwarding username and hostname variables in the filtered CLI environment and documented required desktop-agent capabilities.

## [0.1.3] - 2026-09-16

### Changed

- Includes the Claude Synapse identity migration and verified release pipeline prepared for 0.1.2.

### Removed

- Removed the ineffective **Infinite sessions** chat-menu toggle. Conversation compaction is managed by the Claude Agent SDK and Claude CLI.

## [0.1.2] - 2026-09-14

### Changed

- Renamed the public plugin identity to **Claude Synapse** (`claude-synapse`), with a secure migration path from `synapse`.
- Hardened the release workflow with deterministic source, version, generated-asset, and uploaded-asset verification before publication.

## [0.1.1] - 2026-09-14

### Changed

- Maintenance release.

## [0.1.0] - 2026-09-13

Initial release.
