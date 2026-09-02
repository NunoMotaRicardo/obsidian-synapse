# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
