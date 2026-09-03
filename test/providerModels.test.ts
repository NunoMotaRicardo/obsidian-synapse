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

// ---------------------------------------------------------------------------
// Ollama discovery fixes (issue #120):
//   1. `/api/show` calls are bound-concurrent, not serial — a 20-model library
//      should not issue its `/api/show` requests one at a time.
//   2. `ollamaShowCache` is keyed on `baseUrl + '\0' + id`, not `id` alone, so
//      switching hosts does not serve stale capabilities for a same-named model.
// ---------------------------------------------------------------------------
describe('ollama /api/show discovery (#120)', () => {
	it('parallelises /api/show calls instead of awaiting them serially', async () => {
		const modelCount = 12;
		const tagsBody = {
			models: Array.from({length: modelCount}, (_, i) => ({name: `model-${i}`, details: {family: 'llama'}})),
		};

		let inFlight = 0;
		let maxInFlight = 0;
		const showCallOrder: number[] = [];

		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/api/tags')) {
				return Promise.resolve(jsonResponse(200, tagsBody));
			}
			if (req.url.endsWith('/api/show')) {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				showCallOrder.push(inFlight);
				return new Promise((resolve) => {
					setTimeout(() => {
						inFlight--;
						resolve(jsonResponse(200, {capabilities: ['tools']}));
					}, 5);
				});
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const result = await fetchProviderModels({preset: 'ollama', baseUrl: 'http://localhost:11434'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.models).toHaveLength(modelCount);

		// Serial execution would never have more than one /api/show in flight at once;
		// bound concurrency should let several run together (but not literally all of them,
		// proving there is a cap rather than an unbounded Promise.all).
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThan(modelCount);
	});

	it('does not let one failing /api/show call fail discovery or block the others', async () => {
		const tagsBody = {
			models: [
				{name: 'good-model-1', details: {family: 'llama'}},
				{name: 'bad-model', details: {family: 'llama'}},
				{name: 'good-model-2', details: {family: 'llama'}},
			],
		};

		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string; body?: string};
			if (req.url.endsWith('/api/tags')) {
				return Promise.resolve(jsonResponse(200, tagsBody));
			}
			if (req.url.endsWith('/api/show')) {
				const parsedBody = JSON.parse(req.body || '{}') as {model?: string};
				if (parsedBody.model === 'bad-model') {
					return Promise.reject(new Error('network error'));
				}
				return Promise.resolve(jsonResponse(200, {capabilities: ['tools', 'vision']}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const result = await fetchProviderModels({preset: 'ollama', baseUrl: 'http://localhost:11434'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.models).toHaveLength(3);

		const good1 = result.models.find(m => m.id === 'good-model-1');
		const bad = result.models.find(m => m.id === 'bad-model');
		const good2 = result.models.find(m => m.id === 'good-model-2');
		expect(good1?.supportsTools).toBe(true);
		expect(good2?.supportsTools).toBe(true);
		// The failed /api/show falls back to the heuristic default (false), rather than
		// dropping the model or failing the whole discovery.
		expect(bad?.supportsTools).toBe(false);
	});

	it('keys the capability cache on baseUrl + id, so switching hosts does not serve stale capabilities', async () => {
		const tagsBody = {models: [{name: 'llama3.1', details: {family: 'llama'}}]};

		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/api/tags')) {
				return Promise.resolve(jsonResponse(200, tagsBody));
			}
			if (req.url === 'http://host-a:11434/api/show') {
				return Promise.resolve(jsonResponse(200, {capabilities: ['tools']}));
			}
			if (req.url === 'http://host-b:11434/api/show') {
				// Different host, same model name, genuinely different capabilities (e.g. a
				// vision-capable build on host B).
				return Promise.resolve(jsonResponse(200, {capabilities: ['tools', 'vision']}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const resultA = await fetchProviderModels({preset: 'ollama', baseUrl: 'http://host-a:11434'});
		expect(resultA.ok).toBe(true);
		if (!resultA.ok) return;
		expect(resultA.models[0]?.isVision).toBe(false);

		const resultB = await fetchProviderModels({preset: 'ollama', baseUrl: 'http://host-b:11434'});
		expect(resultB.ok).toBe(true);
		if (!resultB.ok) return;
		// If the cache were keyed on model id alone, this would incorrectly return host A's
		// cached (non-vision) result instead of hitting /api/show again for host B.
		expect(resultB.models[0]?.isVision).toBe(true);

		// Re-querying host A again should still be correct, i.e. re-keying for host B must
		// not have clobbered host A's cache entry either.
		const resultA2 = await fetchProviderModels({preset: 'ollama', baseUrl: 'http://host-a:11434'});
		expect(resultA2.ok).toBe(true);
		if (!resultA2.ok) return;
		expect(resultA2.models[0]?.isVision).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Catalogue capability metadata (issue #129) — `fetchProviderModels()`'s non-Ollama path used
// to guess `isVision`/`supportsReasoning` from a fixed regex over the model id and hardcode
// `supportsTools = true` for every model. It now reads real per-model capability fields when a
// catalogue publishes them (`supported_parameters`, `architecture.input_modalities`,
// `reasoning.supported_efforts` — field names verified against a live
// `GET https://openrouter.ai/api/v1/models` response, 2026-09-03), and falls back to the old
// heuristics — per field independently — only when a catalogue entry omits that field.
// ---------------------------------------------------------------------------
describe('catalogue capability metadata (#129)', () => {
	function mockModelsResponse(models: unknown[]): void {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const url = (request as {url: string}).url;
			if (url.endsWith('/v1/models')) {
				return Promise.resolve(jsonResponse(200, {data: models}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);
	}

	it('reads full metadata (vision, tools, reasoning with custom effort levels) generically, not gated on preset', async () => {
		mockModelsResponse([
			{
				id: 'some-vendor/reasoning-vision-model',
				name: 'Some Vendor: Reasoning Vision Model',
				supported_parameters: ['max_tokens', 'tools', 'reasoning', 'reasoning_effort'],
				architecture: {input_modalities: ['text', 'image']},
				reasoning: {supported_efforts: ['xhigh', 'high', 'medium', 'low', 'minimal']},
			},
		]);

		const result = await fetchProviderModels({preset: 'openai', baseUrl: 'http://localhost:9999'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const model = result.models[0];
		expect(model?.isVision).toBe(true);
		expect(model?.supportsTools).toBe(true);
		expect(model?.capabilities?.supports?.reasoningEffort).toBe(true);
		// The catalogue's own advertised effort levels are used verbatim, not the generic
		// three-level fallback list.
		expect(model?.capabilities?.supportedReasoningEfforts).toEqual(['xhigh', 'high', 'medium', 'low', 'minimal']);
	});

	it('reads a model with no tools/reasoning support from full metadata, not just no metadata', async () => {
		mockModelsResponse([
			{
				id: 'tencent/hy-mt2-1.8b',
				supported_parameters: ['max_completion_tokens', 'max_tokens', 'stop', 'temperature'],
				architecture: {input_modalities: ['text']},
			},
		]);

		const result = await fetchProviderModels({preset: 'openai', baseUrl: 'http://localhost:9999'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const model = result.models[0];
		expect(model?.isVision).toBe(false);
		expect(model?.supportsTools).toBe(false);
		expect(model?.capabilities?.supports?.reasoningEffort).toBe(false);
		expect(model?.capabilities?.supportedReasoningEfforts).toBeUndefined();
	});

	it('falls back to the heuristic for a bare OpenAI-shaped catalogue with no capability fields at all', async () => {
		mockModelsResponse([
			{id: 'gpt-4o-mini', object: 'model', created: 1700000000, owned_by: 'openai'},
			{id: 'gpt-3.5-turbo', object: 'model', created: 1700000000, owned_by: 'openai'},
			{id: 'o1-preview', object: 'model', created: 1700000000, owned_by: 'openai'},
		]);

		const result = await fetchProviderModels({preset: 'openai', baseUrl: 'http://localhost:9999'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const gpt4oMini = result.models.find(m => m.id === 'gpt-4o-mini');
		const gpt35 = result.models.find(m => m.id === 'gpt-3.5-turbo');
		const o1preview = result.models.find(m => m.id === 'o1-preview');

		// Vision heuristic still applies as a last resort.
		expect(gpt4oMini?.isVision).toBe(true);
		expect(gpt35?.isVision).toBe(false);
		// No metadata at all: tools default conservatively to false, not the old unconditional true.
		expect(gpt4oMini?.supportsTools).toBe(false);
		expect(gpt35?.supportsTools).toBe(false);
		// Tightened reasoning heuristic still recognizes the real o1/o3 family.
		expect(o1preview?.capabilities?.supports?.reasoningEffort).toBe(true);
		expect(gpt35?.capabilities?.supports?.reasoningEffort).toBe(false);
	});

	it('does not over-match the tightened reasoning heuristic on ids that merely contain "o1"/"o3" as a substring', async () => {
		mockModelsResponse([
			{id: 'photon-13b'},
			{id: 'co3-turbo'},
		]);

		const result = await fetchProviderModels({preset: 'openai', baseUrl: 'http://localhost:9999'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		for (const model of result.models) {
			expect(model.capabilities?.supports?.reasoningEffort).toBe(false);
		}
	});

	it('handles a partial catalogue: each capability falls back independently per missing field, not the whole model', async () => {
		mockModelsResponse([
			{
				// Vision metadata present, tools/reasoning metadata absent — the fallback for the
				// missing fields must not be dragged down by the presence of the other field.
				id: 'partial/vision-only-metadata',
				architecture: {input_modalities: ['text', 'image']},
			},
			{
				// Tools/reasoning metadata present, vision metadata absent.
				id: 'partial/tools-only-metadata',
				supported_parameters: ['tools'],
			},
		]);

		const result = await fetchProviderModels({preset: 'openai', baseUrl: 'http://localhost:9999'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const visionOnly = result.models.find(m => m.id === 'partial/vision-only-metadata');
		expect(visionOnly?.isVision).toBe(true);
		// No supported_parameters on this entry: falls back to the conservative tools default.
		expect(visionOnly?.supportsTools).toBe(false);

		const toolsOnly = result.models.find(m => m.id === 'partial/tools-only-metadata');
		expect(toolsOnly?.supportsTools).toBe(true);
		// No architecture on this entry: falls back to the vision id heuristic (no match here).
		expect(toolsOnly?.isVision).toBe(false);
	});
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

	// Review round 1: the bare portal "Endpoint" (no /openai suffix) is the value actually
	// shown/copyable in the Azure portal, so it's the more likely wrong paste — not the
	// deployment URL. Must get its own, distinguishable message.
	describe('bare portal Endpoint (missing /openai suffix)', () => {
		it('flags the bare endpoint with no trailing slash', () => {
			const issue = describeAzureBaseUrlIssue('https://my-res.openai.azure.com');
			expect(issue).toBeTruthy();
			expect(issue).toContain('/openai');
		});

		it('flags the bare endpoint with a trailing slash', () => {
			const issue = describeAzureBaseUrlIssue('https://my-res.openai.azure.com/');
			expect(issue).toBeTruthy();
			expect(issue).toContain('/openai');
		});

		it('is a distinct message from the classic-deployment-URL one', () => {
			const bareEndpointIssue = describeAzureBaseUrlIssue('https://my-res.openai.azure.com/');
			const deploymentIssue = describeAzureBaseUrlIssue(
				'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions'
			);
			expect(bareEndpointIssue).not.toEqual(deploymentIssue);
		});

		it('does not flag the correct v1 API base URL without a trailing slash', () => {
			expect(describeAzureBaseUrlIssue('https://my-res.openai.azure.com/openai')).toBeNull();
		});

		it('does not flag the correct v1 API base URL with a trailing slash', () => {
			expect(describeAzureBaseUrlIssue('https://my-res.openai.azure.com/openai/')).toBeNull();
		});

		it('does not flag a non-Azure host missing an /openai path (cannot verify a shape we do not own)', () => {
			expect(describeAzureBaseUrlIssue('https://my-proxy.example.com')).toBeNull();
			expect(describeAzureBaseUrlIssue('https://my-proxy.example.com/')).toBeNull();
		});

		// Review round 2: `.../openai/v1` is a genuinely working base URL — the URL builder's
		// own `endsWith('/v1')` special-case (providerModels.ts:251, :472) makes it resolve to
		// exactly the same `.../openai/v1/...` request as `.../openai`. The helper must not
		// tell a user their working setup is broken.
		it('does not flag the working /openai/v1 base URL without a trailing slash', () => {
			expect(describeAzureBaseUrlIssue('https://my-res.openai.azure.com/openai/v1')).toBeNull();
		});

		it('does not flag the working /openai/v1 base URL with a trailing slash', () => {
			expect(describeAzureBaseUrlIssue('https://my-res.openai.azure.com/openai/v1/')).toBeNull();
		});
	});
});
