import type {ModelInfo} from './copilot';

export type ProviderPreset = 'openai' | 'azure' | 'anthropic' | 'ollama' | 'foundry-local' | 'other-openai';

export interface ProviderConfigOptions {
	preset: ProviderPreset | string;
	baseUrl: string;
	apiKey?: string;
	bearerToken?: string;
}

export type FetchProviderModelsResult =
	| {ok: true; models: ModelInfo[]}
	| {ok: false; error: string; isOllamaConnectionError?: boolean};

const ollamaShowCache = new Map<string, {vision?: boolean; tools?: boolean}>();

export function clearOllamaShowCache(): void {
	ollamaShowCache.clear();
}

export async function fetchProviderModels(options: ProviderConfigOptions): Promise<FetchProviderModelsResult> {
	const preset = (options.preset || 'openai').toLowerCase();
	let baseUrl = (options.baseUrl || '').trim();
	if (!baseUrl) {
		return {ok: false, error: 'Base URL is required.'};
	}

	const token = options.bearerToken || options.apiKey || '';

	if (preset === 'ollama') {
		baseUrl = baseUrl.replace(/\/+$/, '');
		if (baseUrl.endsWith('/v1')) {
			baseUrl = baseUrl.slice(0, -3).replace(/\/+$/, '');
		}
		const tagsUrl = `${baseUrl}/api/tags`;

		const headers: Record<string, string> = {};
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		try {
			const res = await fetch(tagsUrl, {headers});
			if (!res.ok) {
				return {ok: false, error: `HTTP ${res.status} ${res.statusText}`};
			}
			const data = (await res.json()) as {
				models?: Array<{
					name?: string;
					model?: string;
					details?: {family?: string; families?: string[]};
				}>;
			};

			const rawModels = data.models || [];
			const models: ModelInfo[] = [];

			for (const item of rawModels) {
				const id = item.name || item.model || '';
				if (!id) continue;
				const name = item.name || item.model || id;

				const familyList = [
					item.details?.family,
					...(item.details?.families || [])
				]
					.filter(Boolean)
					.map((s) => (s as string).toLowerCase());
				const nameLower = id.toLowerCase();

				let isVision =
					familyList.includes('mllama') ||
					familyList.includes('clip') ||
					/vision|llava|minicpm|moondream|gemma3/.test(nameLower);
				let supportsTools = false;

				const cached = ollamaShowCache.get(id);
				if (cached) {
					if (cached.vision !== undefined) isVision = cached.vision;
					if (cached.tools !== undefined) supportsTools = cached.tools;
				} else {
					try {
						const showUrl = `${baseUrl}/api/show`;
						const showRes = await fetch(showUrl, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								...headers
							},
							body: JSON.stringify({model: id})
						});
						if (showRes.ok) {
							const showData = (await showRes.json()) as {
								capabilities?: string[];
							};
							const caps = showData.capabilities || [];
							if (Array.isArray(caps)) {
								if (caps.includes('vision')) isVision = true;
								if (caps.includes('tools')) supportsTools = true;
								ollamaShowCache.set(id, {
									vision: caps.includes('vision'),
									tools: caps.includes('tools')
								});
							}
						}
					} catch {
						// ignore /api/show network errors, rely on heuristic
					}
				}

				models.push({
					id,
					name,
					capabilities: {
						supports: {
							vision: isVision,
							tools: supportsTools
						}
					},
					isVision,
					supportsTools
				});
			}

			return {ok: true, models};
		} catch (e) {
			return {
				ok: false,
				error: String(e),
				isOllamaConnectionError: true
			};
		}
	} else {
		baseUrl = baseUrl.replace(/\/+$/, '');
		const modelsUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;

		const headers: Record<string, string> = {};
		if (token) {
			if (preset === 'azure') {
				headers['api-key'] = token;
			} else if (preset === 'anthropic') {
				headers['x-api-key'] = token;
				headers['anthropic-version'] = '2023-06-01';
			} else {
				headers['Authorization'] = `Bearer ${token}`;
			}
		}

		try {
			const res = await fetch(modelsUrl, {headers});
			if (!res.ok) {
				return {ok: false, error: `HTTP ${res.status} ${res.statusText}`};
			}
			const data = (await res.json()) as {
				data?: Array<{id?: string; name?: string}>;
			};

			const rawModels = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
			const models: ModelInfo[] = [];

			for (const item of rawModels) {
				const id = item.id || '';
				if (!id) continue;
				const name = item.name || id;

				const isVision = /gpt-4o|gpt-4-vision|claude-3|gemini-1\.5|vision|pixtral/i.test(id);
				const supportsReasoning = /o1|o3/i.test(id);
				const supportsTools = true;

				models.push({
					id,
					name,
					capabilities: {
						supports: {
							vision: isVision,
							reasoningEffort: supportsReasoning,
							tools: supportsTools
						},
						supportedReasoningEfforts: supportsReasoning ? ['low', 'medium', 'high'] : undefined
					},
					isVision,
					supportsTools
				});
			}

			return {ok: true, models};
		} catch (e) {
			return {ok: false, error: String(e)};
		}
	}
}
