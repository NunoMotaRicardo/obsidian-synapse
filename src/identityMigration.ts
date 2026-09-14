import type {App} from 'obsidian';

const LEGACY_CLAUDE_BRAIN_PREFIX = 'claude-brain-secure-';
const SECURE_PREFIX = 'synapse-secure-';
const SECURE_FIELD_SUFFIXES = ['anthropicApiKey', 'telegramBotToken', 'localAgentEndpointApiKey'] as const;

/**
 * Migrates secure keys used before the plugin was renamed from Claude Brain.
 * App local-storage APIs are vault-scoped, so no raw browser-storage scan is
 * needed for the public `synapse` → `claude-synapse` manifest-ID change.
 */
export function migrateClaudeBrainStorage(app: App): void {
	for (const suffix of SECURE_FIELD_SUFFIXES) {
		const oldKey = LEGACY_CLAUDE_BRAIN_PREFIX + suffix;
		const newKey = SECURE_PREFIX + suffix;
		const oldValue: unknown = app.loadLocalStorage(oldKey);
		if (oldValue == null) continue;
		if (app.loadLocalStorage(newKey) == null) {
			app.saveLocalStorage(newKey, oldValue);
		}
		app.saveLocalStorage(oldKey, null);
	}
}
