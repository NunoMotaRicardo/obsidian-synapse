# vault-paths

## Overview

A small, dependency-free module giving every caller a single source of truth for vault-path
derivation: the vault's on-disk base path, the `_synapse/` customization folder, the SDK plugin
config that points at it, and the `_synapse/settings.json` path.

Source: `src/vaultPaths.ts`.

## Interface

```ts
// Hardcoded vault folder for Synapse customization artifacts (agents,
// skills, .mcp.json). Canonical definition — settings.ts re-exports
// it so configWriter.ts's existing `import {SYNAPSE_FOLDER} from './settings'`
// keeps working unmodified (see Invariants).
export const SYNAPSE_FOLDER = '_synapse';

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

// Absolute on-disk path to the vault's own settings layer, `_synapse/settings.json`.
// Pure path derivation only — does not check existence or read the
// file; see agentService.ts's AgentService#loadVaultSettings for that.
export function getSynapseSettingsPath(app: App): string
```

## Design decisions

- **`getVaultBasePath` throws rather than returning `null`.** Synapse is desktop-only (see
  `CLAUDE.md`), so the adapter is always a `FileSystemAdapter` with a real `basePath` in practice;
  a `null`-returning signature would have forced every call site to add a check that can never
  meaningfully fail, for no benefit. Keeping the return type `string` preserves that assumption. A
  missing `basePath` throws a clear `[synapse]`-prefixed error immediately, instead of silently
  returning `undefined` and surfacing later as a cryptic `Cannot read properties of undefined
  (reading 'replace')` from whichever string-concat call used it first.
- **`SYNAPSE_FOLDER` is defined here; `settings.ts` re-exports it.** `vault-paths.ts` is the
  canonical definition; `settings.ts` does `import {SYNAPSE_FOLDER} from './vaultPaths'; export
  {SYNAPSE_FOLDER};` so `configWriter.ts`'s `import {SYNAPSE_FOLDER} from './settings'` keeps
  compiling unmodified. `vaultPaths.ts` has zero internal imports (only `type {App} from
  'obsidian'`), so `settings.ts → vaultPaths.ts` cannot cycle back. All other consumers
  (`bots/telegramBot.ts`, `synapseView.ts`) import `SYNAPSE_FOLDER` directly from `./vaultPaths`.
- **`LocalPluginConfig` is a locally-defined structural type, not an import of `SdkPluginConfig`
  from `agentService.ts`.** Importing it would pull `vaultPaths.ts` into `agentService.ts`'s
  dependency graph. Since `LocalPluginConfig` only needs `{type: 'local'; path: string}` — a
  strict subset of `SdkPluginConfig` (which adds an optional `skipMcpDiscovery`) — every caller's
  `plugins: SdkPluginConfig[]` field accepts `getSynapsePluginConfig()`'s return value
  structurally, with no cast and no import needed.

## Integration points

- **`bots/telegramBot.ts`** — `TelegramBot.getVaultBasePath()` (private method) delegates to
  `getVaultBasePath(this.plugin.app)`; `buildBotSessionConfig()` uses `getSynapsePluginConfig`;
  `SYNAPSE_FOLDER` for the bot-attachments temp folder and agent/skill scan paths.
- **`editor/editorMenu.ts`** — `getAbsolutePath` (image context-menu actions) and `getVaultPlugins`
  (inline-chat plugin discovery) both delegate to `getVaultBasePath`/`getSynapsePluginConfig`.
- **`modals/editModal.ts`** — `plugins` field of its `inlineChat()` call uses
  `getSynapsePluginConfig`.
- **`synapseView.ts`** — `SynapseView.getVaultBasePath()` (public method, called throughout
  `view/*` prototype-extension modules) delegates to `getVaultBasePath(this.app)`;
  `buildSessionConfig()` uses `getSynapsePluginConfig`; `SYNAPSE_FOLDER` for agent/skill
  scan paths.
- **`view/searchPanel.ts`** — `buildSearchSessionConfig()` uses `getSynapsePluginConfig`.
- **`agentService.ts`** — `AgentService#loadVaultSettings()` uses `getSynapseSettingsPath`
  to locate `_synapse/settings.json`, the sole caller of that function.

**Not touched:** `configWriter.ts`. Its `_synapse` occurrences are seeded skill prose
(user-facing markdown describing the folder layout to the vault reader), not path derivation.
Similarly, the self-improve system-prompt text in `view/sessionConfig.ts` describes the folder
layout to a human/model reader rather than resolving a path.

## Invariants

- `getVaultBasePath` never returns `undefined`/`null` — either a non-empty `string`, or it throws.
- `SYNAPSE_FOLDER` is defined exactly once (`vaultPaths.ts`); every other module imports it
  rather than redefining.
- No inline `_synapse` string literal or `basePath` cast remains outside `vaultPaths.ts`,
  `configWriter.ts` (prose only — see Integration points), and prose comments/user-facing copy
  elsewhere.

`src/vaultPaths.ts` exports `SYNAPSE_FOLDER`, `getVaultBasePath`,
`getSynapsePluginConfig`, and `getSynapseSettingsPath`. Unit tests in
`test/vaultPaths.test.ts` cover the basePath cast/throw and backslash normalization in the plugin
config path and the settings path.


