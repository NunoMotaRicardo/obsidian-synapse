# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
