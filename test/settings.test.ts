import {describe, it, expect} from 'vitest';
import {DEFAULT_SETTINGS} from '../src/settings';

// ---------------------------------------------------------------------------
// Legacy settings-key tolerance (issues #106, #148)
//
// `contextTier` and `reasoningSummary` were removed from `SynapseSettings`
// (they were pre-Agent-SDK no-ops, never wired to the Agent SDK). `synapseFolder`
// (issue #148) was removed for the same reason from the opposite direction: it was
// declared and defaulted but nothing in `src/` ever read it — the vault folder path
// comes from the `SYNAPSE_FOLDER` constant (`src/vaultPaths.ts`) throughout, so
// dropping the setting changes no behaviour. Existing `data.json` files written by
// older plugin versions still contain these keys. `SynapsePlugin.loadSettings()`
// merges persisted data over `DEFAULT_SETTINGS` via
// `Object.assign({}, DEFAULT_SETTINGS, raw)` — this test exercises that exact merge
// shape to confirm stale keys survive as harmless extra properties rather than
// causing a load error or clobbering unrelated settings.
// ---------------------------------------------------------------------------

describe('legacy settings key tolerance', () => {
	/** A `data.json` payload written by a pre-#106/#148 plugin version. */
	const legacyRaw = {
		authType: 'apiKey',
		reasoningEffort: 'high',
		// Removed pre-Agent-SDK keys, still present in old data.json files:
		contextTier: 'long_context',
		reasoningSummary: 'detailed',
		// Removed dead setting (#148), still present in old data.json files:
		synapseFolder: '_some_custom_folder',
	};

	it('merging legacy raw data over DEFAULT_SETTINGS does not throw', () => {
		expect(() => Object.assign({}, DEFAULT_SETTINGS, legacyRaw)).not.toThrow();
	});

	it('preserves unrelated settings from raw data', () => {
		const merged = Object.assign({}, DEFAULT_SETTINGS, legacyRaw);
		expect(merged.authType).toBe('apiKey');
		expect(merged.reasoningEffort).toBe('high');
	});

	it('keeps other DEFAULT_SETTINGS fields intact when raw omits them', () => {
		const merged = Object.assign({}, DEFAULT_SETTINGS, legacyRaw);
		expect(merged.toolApproval).toBe(DEFAULT_SETTINGS.toolApproval);
		expect(merged.infiniteSessionsEnabled).toBe(DEFAULT_SETTINGS.infiniteSessionsEnabled);
	});

	it('the removed keys are absent from DEFAULT_SETTINGS (no longer part of the typed shape)', () => {
		expect(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'contextTier')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'reasoningSummary')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'synapseFolder')).toBe(false);
	});

	it('stale legacy keys survive the merge as harmless untyped properties (not stripped, not erroring)', () => {
		const merged = Object.assign({}, DEFAULT_SETTINGS, legacyRaw) as unknown as Record<string, unknown>;
		expect(merged.contextTier).toBe('long_context');
		expect(merged.reasoningSummary).toBe('detailed');
		expect(merged.synapseFolder).toBe('_some_custom_folder');
	});
});
