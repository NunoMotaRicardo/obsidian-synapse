# Branding Cleanup: Legacy Sidekick References Update

Status: **functional decision agreed** (2026-06-30)

## Context

The plugin transitioned from a Copilot-based client named "Sidekick" (`obsidian-sidekick`) to a Claude-native client named "Synapse" (`obsidian-synapse`). While the core codebase and view files have been renamed, several configuration files, documentation guides under `wiki/`, developer instructions in `.github/`, and custom ESLint rules still contain references to the legacy "Sidekick" name. This audit ensures branding consistency across all user-facing documentation and metadata before community release.

## Decision

Perform a repository-wide sweep to update all legacy references of "Sidekick", "obsidian-sidekick", or related terms to "Synapse", "obsidian-synapse", or `_synapse/` configuration paths. 
This includes:
- Updating `README.md` to reflect the new Synapse branding, features, and setup instructions.
- Renaming custom ESLint rules and plugin identifiers in `eslint.config.mts` from `sidekick-custom` to `synapse-custom`.
- Updating developer guides under `.github/` to refer to Synapse.
- Updating all documentation guides in `wiki/` to use the Synapse name and the correct `_synapse/` configuration folder path.
- Standardizing architecture and feature specifications in `.docs/specs/`.

## Rationale

A unified project name prevents confusion for new users and contributors. Since the plugin is being prepared for an open-source community release, any lingering "Sidekick" references would look unpolished and conflict with the actual runtime folder layout (`_synapse/`) and class names (`SynapsePlugin`, `SynapseView`).

## Scope / Non-goals

Renaming internal developer-only files (such as `.claude/agents/sidekick-*.md` scripts and agent definitions) is out of scope for this sweep as they are not user-facing. Historical references to the repository's origin as a fork (like in `AGENTS.md` and `CLAUDE.md`) will be maintained or adjusted for clarity but do not require complete replacement.

## Open Questions

None.

## Hand-off Notes for the Technical Planner

1. Update the specifications in `.docs/specs/` (e.g., `.docs/specs/chat-view.md`) to use Synapse terminology and paths.
2. Update custom ESLint rule references in `eslint.config.mts`.
3. Update `README.md` and the rest of the documentation.
