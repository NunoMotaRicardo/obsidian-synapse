import {describe, it, expect, beforeEach, vi} from 'vitest';
import {requestUrl} from 'obsidian';
import {
	fetchProviderModels,
	executeLocalProviderQuery,
	migrateProviderPreset,
	describeAzureBaseUrlIssue,
	clearOllamaShowCache,
	clearCachedDefaultModel,
	type ProviderPreset,
} from '../src/providerModels';

// ---------------------------------------------------------------------------
// Provider preset matrix (issue #117) — `ProviderPreset` was narrowed from six
// values to three real code paths: 'ollama' | 'openai' | 'azure'. This file is
// the table-driven lock the research report (.docs/research/2026-09-03-provider
// -matrix.md §1, §2.2, §2.3, §2.5) recommended: for every surviving preset,
// across both a bare base URL and a trailing-`/v1` one, assert the constructed
// model-list URL, chat URL, auth header and request body shape.
//
// Every removed preset (`other-openai`, `foundry-local`, `anthropic`) fell into
// the same `else` branch as `openai` in the pre-#117 code, so this matrix also
// covers what those aliases now migrate to (see the `migrateProviderPreset`
// describe block below).
// ---------------------------------------------------------------------------

const mockedRequestUrl = vi.mocked(requestUrl);

interface MockResponse {
	status: number;
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

// Obsidian's RequestUrlResponse exposes `json`/`text`/`arrayBuffer` as already-resolved
// plain values (see obsidian.d.ts RequestUrlResponse), not methods like `fetch()`'s
// Response — providerModels.ts reads `res.json` directly (`providerModels.ts:69`, etc.).
function jsonResponse(status: number, body: unknown): MockResponse {
	return {
		status,
		json: body,
		text: JSON.stringify(body),
		arrayBuffer: new ArrayBuffer(0),
		headers: {},
	};
}

beforeEach(() => {
	clearOllamaShowCache();
	clearCachedDefaultModel();
	mockedRequestUrl.mockReset();
	mockedRequestUrl.mockImplementation(((request: unknown) => {
		const url = (request as {url: string}).url;
		if (url.endsWith('/api/tags')) {
			return Promise.resolve(jsonResponse(200, {models: [{name: 'llama3', details: {family: 'llama'}}]}));
		}
		if (url.endsWith('/api/show')) {
			return Promise.resolve(jsonResponse(200, {capabilities: ['tools']}));
		}
		if (url.endsWith('/api/chat')) {
			return Promise.resolve(jsonResponse(200, {message: {role: 'assistant', content: 'pong'}}));
		}
		if (url.endsWith('/v1/models')) {
			return Promise.resolve(jsonResponse(200, {data: [{id: 'test-model'}]}));
		}
		if (url.endsWith('/v1/chat/completions')) {
			return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'pong'}}]}));
		}
		return Promise.resolve(jsonResponse(404, {}));
	}) as typeof requestUrl);
});

interface PresetCase {
	preset: ProviderPreset;
	/** Which ProviderConfigOptions field carries the secret for this preset in Synapse's settings UI. */
	authField: 'apiKey' | 'bearerToken';
	expectedAuthHeaderKey: string;
	expectedAuthHeaderValue: string;
}

const PRESET_CASES: PresetCase[] = [
	{preset: 'ollama', authField: 'bearerToken', expectedAuthHeaderKey: 'Authorization', expectedAuthHeaderValue: 'Bearer test-token'},
	{preset: 'openai', authField: 'apiKey', expectedAuthHeaderKey: 'Authorization', expectedAuthHeaderValue: 'Bearer test-token'},
	{preset: 'azure', authField: 'apiKey', expectedAuthHeaderKey: 'api-key', expectedAuthHeaderValue: 'test-token'},
];

interface BaseUrlCase {
	label: string;
	/** Base URL as the user would enter it for this preset. */
	baseUrl: (preset: ProviderPreset) => string;
	/** Expected model-list URL for this preset, given the base URL above. */
	expectedModelsUrl: (preset: ProviderPreset) => string;
	/** Expected chat URL for this preset, given the base URL above. */
	expectedChatUrl: (preset: ProviderPreset) => string;
}

const BASE_URL_CASES: BaseUrlCase[] = [
	{
		label: 'bare base URL (no /v1 suffix)',
		baseUrl: () => 'http://localhost:9999',
		expectedModelsUrl: (preset) => preset === 'ollama' ? 'http://localhost:9999/api/tags' : 'http://localhost:9999/v1/models',
		expectedChatUrl: (preset) => preset === 'ollama' ? 'http://localhost:9999/api/chat' : 'http://localhost:9999/v1/chat/completions',
	},
	{
		label: 'trailing-/v1 base URL',
		baseUrl: () => 'http://localhost:9999/v1',
		expectedModelsUrl: (preset) => preset === 'ollama' ? 'http://localhost:9999/api/tags' : 'http://localhost:9999/v1/models',
		expectedChatUrl: (preset) => preset === 'ollama' ? 'http://localhost:9999/api/chat' : 'http://localhost:9999/v1/chat/completions',
	},
];

describe('provider preset matrix', () => {
	for (const presetCase of PRESET_CASES) {
		for (const urlCase of BASE_URL_CASES) {
			describe(`${presetCase.preset} — ${urlCase.label}`, () => {
				const options = {
					preset: presetCase.preset,
					baseUrl: urlCase.baseUrl(presetCase.preset),
					[presetCase.authField]: 'test-token',
				};

				it('requests the expected model-list URL', async () => {
					const result = await fetchProviderModels(options);
					expect(result.ok).toBe(true);

					const call = mockedRequestUrl.mock.calls.find(
						([opts]) => (opts as {url: string}).url === urlCase.expectedModelsUrl(presetCase.preset)
					);
					expect(call, `expected a request to ${urlCase.expectedModelsUrl(presetCase.preset)}, got: ${mockedRequestUrl.mock.calls.map(([o]) => (o as {url: string}).url).join(', ')}`).toBeDefined();
				});

				it('sends the expected auth header on the model-list request', async () => {
					await fetchProviderModels(options);

					const call = mockedRequestUrl.mock.calls.find(
						([opts]) => (opts as {url: string}).url === urlCase.expectedModelsUrl(presetCase.preset)
					);
					const headers = (call?.[0] as {headers?: Record<string, string>} | undefined)?.headers || {};
					expect(headers[presetCase.expectedAuthHeaderKey]).toBe(presetCase.expectedAuthHeaderValue);
				});

				it('requests the expected chat URL, auth header and body shape', async () => {
					mockedRequestUrl.mockClear();
					const result = await executeLocalProviderQuery(options, {prompt: 'ping', model: 'test-model'});
					expect(result.ok).toBe(true);

					const call = mockedRequestUrl.mock.calls.find(
						([opts]) => (opts as {url: string}).url === urlCase.expectedChatUrl(presetCase.preset)
					);
					expect(call, `expected a request to ${urlCase.expectedChatUrl(presetCase.preset)}, got: ${mockedRequestUrl.mock.calls.map(([o]) => (o as {url: string}).url).join(', ')}`).toBeDefined();

					const callOpts = call?.[0] as {method?: string; headers?: Record<string, string>; body?: string} | undefined;
					expect(callOpts?.method).toBe('POST');
					expect(callOpts?.headers?.[presetCase.expectedAuthHeaderKey]).toBe(presetCase.expectedAuthHeaderValue);
					expect(callOpts?.headers?.['Content-Type']).toBe('application/json');

					const body = JSON.parse(callOpts?.body || '{}') as {
						model?: string;
						messages?: Array<{role: string; content: unknown; images?: string[]}>;
						stream?: boolean;
					};
					expect(body.model).toBe('test-model');
					expect(body.messages?.[0]).toMatchObject({role: 'user'});

					if (presetCase.preset === 'ollama') {
						// Ollama-native shape: plain string content, `stream: false`, no OpenAI
						// `image_url` content parts (providerModels.ts:290-296).
						expect(body.stream).toBe(false);
						expect(body.messages?.[0]?.content).toBe('ping');
					} else {
						// OpenAI-compatible shape (openai, azure): no `stream` field on this path.
						expect(body.stream).toBeUndefined();
						expect(body.messages?.[0]?.content).toBe('ping');
					}
				});
			});
		}
	}
});

describe('migrateProviderPreset', () => {
	it('passes surviving presets through unchanged', () => {
		expect(migrateProviderPreset('ollama')).toEqual({preset: 'ollama', migrated: false, wasAnthropic: false});
		expect(migrateProviderPreset('openai')).toEqual({preset: 'openai', migrated: false, wasAnthropic: false});
		expect(migrateProviderPreset('azure')).toEqual({preset: 'azure', migrated: false, wasAnthropic: false});
	});

	it('silently maps other-openai to openai', () => {
		expect(migrateProviderPreset('other-openai')).toEqual({preset: 'openai', migrated: true, wasAnthropic: false});
	});

	it('silently maps foundry-local to openai', () => {
		expect(migrateProviderPreset('foundry-local')).toEqual({preset: 'openai', migrated: true, wasAnthropic: false});
	});

	it('maps anthropic to openai and flags it for a one-time notice', () => {
		expect(migrateProviderPreset('anthropic')).toEqual({preset: 'openai', migrated: true, wasAnthropic: true});
	});

	it('falls back to openai (migrated: true) for a genuinely unrecognized non-empty value', () => {
		// Distinguishes "nothing was ever stored" (below) from "a stored string that isn't
		// any known preset, past or present" — both must NOT be conflated (review round 1).
		expect(migrateProviderPreset('some-future-preset')).toEqual({preset: 'openai', migrated: true, wasAnthropic: false});
		expect(migrateProviderPreset('sagemaker')).toEqual({preset: 'openai', migrated: true, wasAnthropic: false});
	});

	// -------------------------------------------------------------------
	// Regression (#117 review round 1): an absent providerPreset must NOT be treated as an
	// unrecognized legacy value. `Object.assign({}, DEFAULT_SETTINGS, raw)` in
	// `main.ts#loadSettings()` already seeds `'ollama'` (settings.ts DEFAULT_SETTINGS) for a
	// fresh install or a data.json predating this setting; `migrated: false` here is what
	// tells the caller to leave that default untouched instead of overwriting it with the
	// generic-unknown-value fallback.
	// -------------------------------------------------------------------
	it('does not treat an absent value as a legacy alias (migrated: false, so DEFAULT_SETTINGS wins)', () => {
		expect(migrateProviderPreset(undefined)).toEqual({preset: 'ollama', migrated: false, wasAnthropic: false});
	});

	it('does not treat null as a legacy alias', () => {
		expect(migrateProviderPreset(null)).toEqual({preset: 'ollama', migrated: false, wasAnthropic: false});
	});

	it('does not treat an empty string as a legacy alias', () => {
		expect(migrateProviderPreset('')).toEqual({preset: 'ollama', migrated: false, wasAnthropic: false});
	});

	it('does not treat a whitespace-only string as a legacy alias', () => {
		expect(migrateProviderPreset('   ')).toEqual({preset: 'ollama', migrated: false, wasAnthropic: false});
		expect(migrateProviderPreset('\t\n')).toEqual({preset: 'ollama', migrated: false, wasAnthropic: false});
	});
});

// ---------------------------------------------------------------------------
// describeAzureBaseUrlIssue (issue #119) — Azure's classic deployment-scoped chat URL
// (`.../openai/deployments/<deployment>/chat/completions?api-version=...`) is a shape
// Synapse's URL builder can never produce; it always requests `{base}/v1/...`. This is the
// predictable wrong input a user pastes straight from the Azure portal, so the Test button
// should name the fix instead of a bare 404.
// ---------------------------------------------------------------------------
describe('describeAzureBaseUrlIssue', () => {
	it('flags a classic deployment-scoped URL', () => {
		const issue = describeAzureBaseUrlIssue(
			'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions'
		);
		expect(issue).toBeTruthy();
		expect(issue).toContain('v1');
	});

	it('flags a URL carrying an api-version query param', () => {
		const issue = describeAzureBaseUrlIssue(
			'https://my-res.openai.azure.com/openai?api-version=2024-02-01'
		);
		expect(issue).toBeTruthy();
	});

	it('flags a URL with both fingerprints', () => {
		const issue = describeAzureBaseUrlIssue(
			'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01'
		);
		expect(issue).toBeTruthy();
	});

	it('is case-insensitive about the fingerprints', () => {
		expect(describeAzureBaseUrlIssue('https://my-res.openai.azure.com/openai/DEPLOYMENTS/gpt-4o')).toBeTruthy();
		expect(describeAzureBaseUrlIssue('https://my-res.openai.azure.com/openai?API-VERSION=2024-02-01')).toBeTruthy();
	});

	it('does not flag the correct v1 API base URL', () => {
		expect(describeAzureBaseUrlIssue('https://my-res.openai.azure.com/openai')).toBeNull();
	});

	it('does not flag an unrelated base URL', () => {
		expect(describeAzureBaseUrlIssue('https://api.openai.com')).toBeNull();
	});

	it('does not flag an empty base URL (fetchProviderModels already reports that case)', () => {
		expect(describeAzureBaseUrlIssue('')).toBeNull();
		expect(describeAzureBaseUrlIssue('   ')).toBeNull();
	});
});
