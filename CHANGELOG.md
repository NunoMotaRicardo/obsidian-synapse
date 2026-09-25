# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
