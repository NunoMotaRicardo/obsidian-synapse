import {describe, it, expect} from 'vitest';
import {createMockApp} from './setup';
import {
	SYNAPSE_FOLDER,
	getVaultBasePath,
	getSynapsePluginConfig,
	getSynapseSettingsPath,
} from '../src/vaultPaths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('SYNAPSE_FOLDER', () => {
	it('SYNAPSE_FOLDER is the hardcoded vault customization folder', () => {
		expect(SYNAPSE_FOLDER).toBe('_synapse');
	});
});

// ---------------------------------------------------------------------------
// getVaultBasePath
// ---------------------------------------------------------------------------

describe('getVaultBasePath', () => {
	it('returns the adapter basePath as-is', () => {
		const app = createMockApp('C:/mock-vault') as unknown as import('obsidian').App;
		expect(getVaultBasePath(app)).toBe('C:/mock-vault');
	});

	it('preserves a POSIX-style basePath (no normalization applied)', () => {
		const app = createMockApp('/home/user/vault') as unknown as import('obsidian').App;
		expect(getVaultBasePath(app)).toBe('/home/user/vault');
	});

	it('throws a clear [synapse] error when the adapter has no basePath (non-filesystem adapter)', () => {
		const app = createMockApp('') as unknown as import('obsidian').App;
		expect(() => getVaultBasePath(app)).toThrow(/\[synapse\]/);
	});
});

// ---------------------------------------------------------------------------
// getSynapsePluginConfig
// ---------------------------------------------------------------------------

describe('getSynapsePluginConfig', () => {
	it('returns a single local plugin config pointing at <basePath>/_synapse/', () => {
		const app = createMockApp('C:/mock-vault') as unknown as import('obsidian').App;
		expect(getSynapsePluginConfig(app)).toEqual([{type: 'local', path: 'C:/mock-vault/_synapse/'}]);
	});

	it('normalizes Windows backslashes in the basePath to forward slashes', () => {
		const app = createMockApp('C:\\Users\\me\\vault') as unknown as import('obsidian').App;
		expect(getSynapsePluginConfig(app)).toEqual([{type: 'local', path: 'C:/Users/me/vault/_synapse/'}]);
	});

	it('propagates getVaultBasePath()\'s throw when there is no basePath', () => {
		const app = createMockApp('') as unknown as import('obsidian').App;
		expect(() => getSynapsePluginConfig(app)).toThrow(/\[synapse\]/);
	});
});

// ---------------------------------------------------------------------------
// getSynapseSettingsPath
// ---------------------------------------------------------------------------

describe('getSynapseSettingsPath', () => {
	it('returns <basePath>/_synapse/settings.json', () => {
		const app = createMockApp('C:/mock-vault') as unknown as import('obsidian').App;
		expect(getSynapseSettingsPath(app)).toBe('C:/mock-vault/_synapse/settings.json');
	});

	it('normalizes Windows backslashes in the basePath to forward slashes', () => {
		const app = createMockApp('C:\\Users\\me\\vault') as unknown as import('obsidian').App;
		expect(getSynapseSettingsPath(app)).toBe('C:/Users/me/vault/_synapse/settings.json');
	});

	it('propagates getVaultBasePath()\'s throw when there is no basePath', () => {
		const app = createMockApp('') as unknown as import('obsidian').App;
		expect(() => getSynapseSettingsPath(app)).toThrow(/\[synapse\]/);
	});
});
