import {describe, expect, it, vi} from 'vitest';
import type {App} from 'obsidian';
import {migrateClaudeBrainStorage} from '../src/identityMigration';

function makeApp(values: Record<string, unknown> = {}): {app: App; values: Map<string, unknown>} {
	const stored = new Map<string, unknown>(Object.entries(values));
	return {
		app: {
			loadLocalStorage: (key: string) => stored.get(key) ?? null,
			saveLocalStorage: (key: string, value: unknown) => stored.set(key, value),
		} as unknown as App,
		values: stored,
	};
}

describe('identity localStorage migration (#254)', () => {
	it('never touches process-wide browser storage from another vault', () => {
		const {app, values} = makeApp({
			'claude-brain-secure-anthropicApiKey': 'current-vault-api-key',
		});
		const fail = (operation: string): never => {
			throw new Error(`Migration must not ${operation} process-wide browser storage`);
		};
		const getItem = vi.fn((key: string) => fail(`read ${key}`));
		const key = vi.fn((index: number) => fail(`read key ${index}`));
		const setItem = vi.fn((key: string) => fail(`write ${key}`));
		const removeItem = vi.fn((key: string) => fail(`delete ${key}`));
		const clear = vi.fn(() => fail('clear'));
		const storage = new Proxy({
			'vault-alpha:plugin:synapse-secure-anthropicApiKey': 'foreign-api-key',
			'vault-beta:plugin:synapse-secure-telegramBotToken': 'foreign-bot-token',
			'vault-beta:plugin:synapse-secure-localAgentEndpointApiKey': 'foreign-endpoint-key',
			getItem,
			key,
			setItem,
			removeItem,
			clear,
		}, {
			ownKeys: () => fail('enumerate'),
		}) as unknown as Storage;
		let browserStorageReferences = 0;
		const fakeWindow = {};
		Object.defineProperty(fakeWindow, 'localStorage', {
			get: () => {
				browserStorageReferences++;
				return storage;
			},
		});
		vi.stubGlobal('window', fakeWindow);
		vi.stubGlobal('localStorage', storage);

		try {
			migrateClaudeBrainStorage(app);
		} finally {
			vi.unstubAllGlobals();
		}

		expect(values.get('synapse-secure-anthropicApiKey')).toBe('current-vault-api-key');
		expect(browserStorageReferences).toBe(0);
		expect(getItem).not.toHaveBeenCalled();
		expect(key).not.toHaveBeenCalled();
		expect(setItem).not.toHaveBeenCalled();
		expect(removeItem).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
	});

	it('migrates every historical Claude Brain secure field without replacing current values', () => {
		const {app, values} = makeApp({
			'claude-brain-secure-anthropicApiKey': 'old-api-key',
			'claude-brain-secure-telegramBotToken': 'old-bot-token',
			'claude-brain-secure-localAgentEndpointApiKey': 'old-endpoint-key',
			'synapse-secure-telegramBotToken': 'current-token',
		});

		migrateClaudeBrainStorage(app);

		expect(values.get('synapse-secure-anthropicApiKey')).toBe('old-api-key');
		expect(values.get('synapse-secure-telegramBotToken')).toBe('current-token');
		expect(values.get('synapse-secure-localAgentEndpointApiKey')).toBe('old-endpoint-key');
		expect(values.get('claude-brain-secure-anthropicApiKey')).toBeNull();
		expect(values.get('claude-brain-secure-telegramBotToken')).toBeNull();
		expect(values.get('claude-brain-secure-localAgentEndpointApiKey')).toBeNull();
	});
});
