/**
 * Vault path derivation — a small, dependency-free module giving every
 * caller a single source of truth for the vault's on-disk base path, the
 * `_synapse/` customization folder, the SDK plugin config that points at
 * it, the reports folder, and today's date string for report filenames.
 *
 * Extracted here (rather than duplicated) because `getVaultBasePath()`'s
 * `basePath` cast, the `_synapse/`-plugin-config object shape, and
 * `todayString()` were each independently copy-pasted across 6-7 call
 * sites (`batchLoopExecutor.ts`, `bots/telegramBot.ts`, `editor/editorMenu.ts`,
 * `modals/editModal.ts`, `synapseView.ts`, `runExecutor.ts`,
 * `view/searchPanel.ts`) — see issue #153. Model: `src/budget.ts` (#74's
 * extraction for the same reason, one level down).
 */

import type {App} from 'obsidian';

/**
 * Hardcoded vault folder for Synapse customization artifacts (agents,
 * skills, reports, `.mcp.json`). Canonical definition — every
 * other module imports it from here. `settings.ts` re-exports it (rather
 * than importing it under a new name) so `configWriter.ts`'s existing
 * `import {SYNAPSE_FOLDER} from './settings'` keeps working unmodified.
 */
export const SYNAPSE_FOLDER = '_synapse';

/** Vault-relative folder where batch loops append their run reports. */
export const REPORTS_FOLDER = `${SYNAPSE_FOLDER}/reports`;

/**
 * SDK plugin config pointing at the vault's `_synapse/` folder, in the
 * shape `agentService.ts`'s `SdkPluginConfig` expects. Defined locally
 * (rather than importing `SdkPluginConfig` from `agentService.ts`) to keep
 * this module free of internal imports — see `specs/vault-paths.md`
 * for the import-cycle check this avoids. Structurally assignable to
 * `SdkPluginConfig[]` (a strict subset: no `skipMcpDiscovery`).
 */
export interface LocalPluginConfig {
	type: 'local';
	path: string;
}

/**
 * Absolute on-disk path to the vault's root folder.
 *
 * Obsidian only exposes this on filesystem-backed adapters (desktop app);
 * Synapse is desktop-only (see `CLAUDE.md`), so every existing call site
 * already assumed this is always present via an unchecked cast. This keeps
 * that assumption — the return type is a plain `string`, never `null` —
 * but throws a clear, `[synapse]`-prefixed error instead of silently
 * returning `undefined` (which previously surfaced downstream as a
 * cryptic `Cannot read properties of undefined` from the first
 * `.replace()`/string-concat call on the result).
 */
export function getVaultBasePath(app: App): string {
	const basePath = (app.vault.adapter as unknown as {basePath?: string}).basePath;
	if (!basePath) {
		throw new Error('[synapse] Vault adapter has no filesystem base path (Synapse requires the desktop app).');
	}
	return basePath;
}

/**
 * SDK `plugins` config for local-plugin discovery of the vault's
 * `_synapse/` folder (agents, skills, `.mcp.json`) — the shape every
 * `inlineChat()`/`Session` call site building its own `SessionConfig`
 * needs for the `plugins` field.
 */
export function getSynapsePluginConfig(app: App): LocalPluginConfig[] {
	const normalizedBase = getVaultBasePath(app).replace(/\\/g, '/');
	return [{type: 'local', path: `${normalizedBase}/${SYNAPSE_FOLDER}/`}];
}

/**
 * Absolute on-disk path to the vault's own settings layer, `_synapse/settings.json` (issue
 * #194) — matching how `getSynapsePluginConfig()` already derives `_synapse/`'s SDK-plugin
 * path. Purely path derivation: this does not check whether the file exists, nor read it — see
 * `AgentService`'s vault-settings-layer merge in `agentService.ts` for that (kept out of this
 * dependency-free module, which must stay free of `node:fs`/internal imports).
 */
export function getSynapseSettingsPath(app: App): string {
	const normalizedBase = getVaultBasePath(app).replace(/\\/g, '/');
	return `${normalizedBase}/${SYNAPSE_FOLDER}/settings.json`;
}

/** Today's date as `YYYY-MM-DD`, for report filenames/headings. */
export function todayString(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
