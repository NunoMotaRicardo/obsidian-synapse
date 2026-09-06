# vault-paths

## Overview

A small, dependency-free module giving every caller a single source of truth for vault-path
derivation: the vault's on-disk base path, the `_synapse/` customization folder, the SDK plugin
config that points at it, the reports folder, and today's-date string used in report filenames.

Extracted (issue #153) because each of these was independently duplicated: the
`(app.vault.adapter as unknown as {basePath: string}).basePath` cast across 7 files, the
`plugins: [{type: 'local', path: '<basePath>/_synapse/'}]` object rebuilt inline at 6 call sites,
and `todayString()` copy-pasted verbatim into `triggerExecutor.ts` and `batchLoopExecutor.ts`.
Model: `src/budget.ts` (#74's extraction for the same reason, one level down — chat/batch-loop
budget primitives rather than vault paths).

Source: `src/vaultPaths.ts`.

## Interface

```ts
// Hardcoded vault folder for Synapse customization artifacts (agents, skills,
// reports, .mcp.json). Canonical definition — settings.ts re-exports
// it so configWriter.ts's existing `import {SYNAPSE_FOLDER} from './settings'`
// keeps working unmodified (see Invariants).
export const SYNAPSE_FOLDER = '_synapse';

// Vault-relative folder where batch loops append their run reports.
export const REPORTS_FOLDER = `${SYNAPSE_FOLDER}/reports`;

// Structurally compatible with agentService.ts's SdkPluginConfig (a strict
// subset — no skipMcpDiscovery). Defined locally rather than imported, to
// keep this module free of internal imports.
export interface LocalPluginConfig {
	type: 'local';
	path: string;
}

// Absolute on-disk path to the vault's root folder. Throws a `[synapse]`-prefixed
// error if the adapter has no filesystem basePath (non-desktop adapter) rather
// than returning it as possibly-undefined.
export function getVaultBasePath(app: App): string

// SDK `plugins` config for local-plugin discovery of the vault's `_synapse/`
// folder. Backslash-normalizes the basePath (SDK plugin paths are POSIX-style).
export function getSynapsePluginConfig(app: App): LocalPluginConfig[]

// Today's date as `YYYY-MM-DD`, for report filenames/headings.
export function todayString(): string
```

## Design decisions

- **`getVaultBasePath` throws rather than returning `null`.** Every pre-extraction call site
  unconditionally cast the adapter to `{basePath: string}` and used the result as a plain
  `string` — none null-checked. Synapse is desktop-only (see `CLAUDE.md`), so the adapter is
  always a `FileSystemAdapter` with a real `basePath` in practice; a `null`-returning signature
  would have forced every call site to add a check that can never meaningfully fail, for no
  benefit. Keeping the return type `string` preserves that assumption. The one deliberate change:
  a missing `basePath` now throws a clear `[synapse]`-prefixed error immediately, instead of
  silently returning `undefined` and surfacing later as a cryptic `Cannot read properties of
  undefined (reading 'replace')` from whichever `.replace()`/string-concat call used it first.
- **`SYNAPSE_FOLDER` moved here from `settings.ts`, which now re-exports it.** `vault-paths.ts` is
  the canonical definition; `settings.ts` does `import {SYNAPSE_FOLDER} from './vaultPaths'; export
  {SYNAPSE_FOLDER};` so `configWriter.ts`'s existing `import {SYNAPSE_FOLDER} from './settings'`
  (out of scope for #153 — `configWriter.ts` was left untouched, see Invariants) keeps compiling
  unmodified. Checked for an import cycle before choosing this: `vaultPaths.ts` has zero internal
  imports (only `type {App} from 'obsidian'`), so `settings.ts → vaultPaths.ts` cannot cycle back —
  even though `settings.ts ↔ configWriter.ts` already had a pre-existing mutual import (unrelated
  to this change, and unaffected by it). All other consumers (`batchLoopExecutor.ts`,
  `bots/telegramBot.ts`, `mcpBridge.ts`, `synapseView.ts`, `triggerExecutor.ts`, `triggers.ts`) were
  switched to import `SYNAPSE_FOLDER` directly from `./vaultPaths`.
- **`LocalPluginConfig` is a locally-defined structural type, not an import of `SdkPluginConfig`
  from `agentService.ts`.** Importing it would pull `vaultPaths.ts` into `agentService.ts`'s
  dependency graph (`agentService.ts → vaultTools.ts → triggers.ts → settings.ts →
  vaultPaths.ts`), i.e. a real cycle back to `vaultPaths.ts` if `settings.ts` also imports from it
  (which it does, per the point above). Since `LocalPluginConfig` only needs `{type: 'local'; path:
  string}` — a strict subset of `SdkPluginConfig` (which adds an optional `skipMcpDiscovery`) —
  every caller's `plugins: SdkPluginConfig[]` field accepts `getSynapsePluginConfig()`'s return
  value structurally, with no cast and no import needed.

## Integration points

- **`batchLoopExecutor.ts`** — `getVaultBasePath`/`getSynapsePluginConfig` in `runOnFile` (per-file
  `inlineChat()` call); `REPORTS_FOLDER`/`todayString` in the report-append path; `SYNAPSE_FOLDER`
  to exclude the customization folder from batch-loop scope resolution.
- **`bots/telegramBot.ts`** — `TelegramBot.getVaultBasePath()` (private method) delegates to
  `getVaultBasePath(this.plugin.app)`; `buildBotSessionConfig()` uses `getSynapsePluginConfig`;
  `SYNAPSE_FOLDER` for the bot-attachments temp folder and agent/skill scan paths.
- **`editor/editorMenu.ts`** — `getAbsolutePath` (image context-menu actions) and `getVaultPlugins`
  (inline-chat plugin discovery) both delegate to `getVaultBasePath`/`getSynapsePluginConfig`.
- **`modals/editModal.ts`** — `plugins` field of its `inlineChat()` call uses
  `getSynapsePluginConfig`.
- **`mcpBridge.ts`** — `SYNAPSE_FOLDER` replaces the inline `'_synapse'` literal in the
  `.mcp.json` config-path join.
- **`synapseView.ts`** — `SynapseView.getVaultBasePath()` (public method, called throughout
  `view/*` prototype-extension modules) delegates to `getVaultBasePath(this.app)`;
  `buildSessionConfig()` uses `getSynapsePluginConfig`; `SYNAPSE_FOLDER` for agent/skill
  scan paths.
- **`runExecutor.ts`** (from #154's extraction of the trigger and batch-loop executors, and the
  sole surviving caller since #188 removed the trigger executor) — `executeWithClaude` uses
  `getVaultBasePath`/`getSynapsePluginConfig`; `executeWithLocalModel` (MCP bridge start) uses
  `getVaultBasePath`; `REPORTS_FOLDER`/`todayString` in the report-append path.
- **`view/searchPanel.ts`** — `buildSearchSessionConfig()` uses `getSynapsePluginConfig`.

**Not touched:** `configWriter.ts` (out of scope for #153 — see Design decisions). Its `_synapse`
occurrences at line 436+ are seeded skill prose (user-facing markdown describing the folder layout
to the vault reader), not path derivation. Similarly left alone: the self-improve system-prompt
text built in `view/sessionConfig.ts` — it describes the folder layout to a human/model reader
rather than resolving a path, and templating it buys nothing while risking a copy change the
acceptance criteria didn't ask for.

## Invariants

- `getVaultBasePath` never returns `undefined`/`null` — either a non-empty `string`, or it throws.
- `SYNAPSE_FOLDER` and `REPORTS_FOLDER` are each defined exactly once (`vaultPaths.ts`); every
  other module imports them rather than redefining.
- `todayString()` is defined exactly once (`vaultPaths.ts`); imported by `runExecutor.ts` (the
  trigger and batch-loop executors' shared successor, #154 — see [run-executor.md](run-executor.md)).
- No inline `_synapse` string literal or `basePath` cast remains outside `vaultPaths.ts`,
  `configWriter.ts` (out of scope, prose only — see Integration points), and prose
  comments/user-facing copy elsewhere.

## Current status

Implemented (issue #153). `src/vaultPaths.ts` exports `SYNAPSE_FOLDER`, `REPORTS_FOLDER`,
`getVaultBasePath`, `getSynapsePluginConfig`, and `todayString`. Unit tests in
`test/vaultPaths.test.ts` cover the basePath cast/throw, backslash normalization in the plugin
config path, and `todayString()`'s zero-padding across fake-timer dates. Purely mechanical
extraction — no behavior change beyond `getVaultBasePath`'s throw-instead-of-silent-`undefined`
on a code path that was already desktop-only and unreachable in practice (see Design decisions).
