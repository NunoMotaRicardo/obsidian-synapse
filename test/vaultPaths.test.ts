import {describe, it, expect, vi, afterEach} from 'vitest';
import {createMockApp} from './setup';
import {
	SYNAPSE_FOLDER,
	REPORTS_FOLDER,
	getVaultBasePath,
	getSynapsePluginConfig,
	todayString,
} from '../src/vaultPaths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('SYNAPSE_FOLDER / REPORTS_FOLDER', () => {
	it('SYNAPSE_FOLDER is the hardcoded vault customization folder', () => {
		expect(SYNAPSE_FOLDER).toBe('_synapse');
	});

	it('REPORTS_FOLDER is derived from SYNAPSE_FOLDER', () => {
		expect(REPORTS_FOLDER).toBe(`${SYNAPSE_FOLDER}/reports`);
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
// todayString
// ---------------------------------------------------------------------------

describe('todayString', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('formats the current date as YYYY-MM-DD', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 4)); // September 4, 2026 (month is 0-indexed)
		expect(todayString()).toBe('2026-09-04');
	});

	it('zero-pads single-digit months and days', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 5)); // January 5, 2026
		expect(todayString()).toBe('2026-01-05');
	});
});
