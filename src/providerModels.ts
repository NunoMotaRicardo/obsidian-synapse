import type {App} from 'obsidian';
import type {ModelInfo} from './agentService';

export interface LocalToolCall {
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string | Record<string, unknown>;
	};
}

export interface LocalTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>, app: App) => Promise<string>;
}

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

export type LocalQueryResult =
	| {ok: true; content: string; truncated?: boolean}
	| {ok: false; error: string};

export function isLocalBackendConfigured(options?: ProviderConfigOptions): boolean {
	return Boolean(options && options.baseUrl && options.baseUrl.trim().length > 0);
}

let cachedDefaultModel: {baseUrl: string; model: string} | null = null;

export function clearCachedDefaultModel(): void {
	cachedDefaultModel = null;
}

async function resolveDefaultModel(options: ProviderConfigOptions): Promise<string> {
	const baseUrl = (options.baseUrl || '').trim();
	if (cachedDefaultModel && cachedDefaultModel.baseUrl === baseUrl) {
		return cachedDefaultModel.model;
	}
	const modelsRes = await fetchProviderModels(options);
	const firstModel = modelsRes.ok && modelsRes.models.length > 0 ? modelsRes.models[0] : undefined;
	const preset = (options.preset || 'openai').toLowerCase();
	const model = firstModel ? firstModel.id : (preset === 'ollama' ? 'llama3' : 'gpt-3.5-turbo');
	cachedDefaultModel = {baseUrl, model};
	return model;
}

export async function executeLocalProviderQuery(
	options: ProviderConfigOptions,
	params: {
		prompt: string;
		systemPrompt?: string;
		model?: string;
		tools?: LocalTool[];
		app?: App;
		maxTurns?: number;
		images?: Array<{mimeType: string; base64: string}>;
	}
): Promise<LocalQueryResult> {
	const baseUrl = (options.baseUrl || '').trim();
	if (!baseUrl) {
		return {ok: false, error: 'Local backend base URL is not configured.'};
	}

	const preset = (options.preset || 'openai').toLowerCase();
	const token = options.bearerToken || options.apiKey || '';

	const targetModel = params.model || await resolveDefaultModel(options);

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
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

	const apiTools = params.tools?.map(t => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}
	}));

	// Ollama's native /api/chat endpoint (used below when preset === 'ollama') does not accept
	// OpenAI-style `content: [{type: 'image_url', ...}]` arrays — it expects `content: string`
	// plus a sibling `images: string[]` (raw base64, no data: URI prefix) on the message.
	// Every other preset goes through an OpenAI-compatible /v1/chat/completions endpoint, which
	// does accept the `image_url` content-part array. Build whichever shape matches the target
	// endpoint; calls with no images keep the existing plain-string content unchanged either way.
	type MessageContent = string | Array<{type: string; text?: string; image_url?: {url: string}}>;
	const messages: Array<{role: string; content: MessageContent; images?: string[]; tool_calls?: LocalToolCall[]; tool_call_id?: string; name?: string}> = [];
	if (params.systemPrompt) {
		messages.push({role: 'system', content: params.systemPrompt});
	}
	if (params.images && params.images.length > 0) {
		if (preset === 'ollama') {
			messages.push({role: 'user', content: params.prompt, images: params.images.map(img => img.base64)});
		} else {
			const content: Array<{type: string; text?: string; image_url?: {url: string}}> = [
				{type: 'text', text: params.prompt},
			];
			for (const img of params.images) {
				content.push({type: 'image_url', image_url: {url: `data:${img.mimeType};base64,${img.base64}`}});
			}
			messages.push({role: 'user', content});
		}
	} else {
		messages.push({role: 'user', content: params.prompt});
	}

	let turn = 0;
	const maxTurns = params.maxTurns ?? 5;
	let latestContent = '';
	let lastNonEmptyContent = '';

	try {
		while (turn < maxTurns) {
			const requestBody: {
				model: string;
				messages: Array<{
					role: string;
					content: MessageContent;
					images?: string[];
					tool_calls?: LocalToolCall[];
					tool_call_id?: string;
					name?: string;
				}>;
				stream?: boolean;
				tools?: Array<{
					type: string;
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}>;
			} = {
				model: targetModel,
				messages,
			};
			if (preset === 'ollama') {
				requestBody.stream = false;
			}
			if (apiTools && apiTools.length > 0) {
				requestBody.tools = apiTools;
			}

			let responseMessage: {
				role?: string;
				content?: string;
				tool_calls?: LocalToolCall[];
			} | undefined;
			let toolCalls: LocalToolCall[] | undefined;

			if (preset === 'ollama') {
				const tempBase = baseUrl.replace(/\/+$/, '');
				const cleanBase = tempBase.endsWith('/v1') ? tempBase.slice(0, -3).replace(/\/+$/, '') : tempBase;
				const chatUrl = `${cleanBase}/api/chat`;
				const res = await fetch(chatUrl, {
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
				});
				if (!res.ok) {
					return {ok: false, error: `Ollama error: HTTP ${res.status} ${res.statusText}`};
				}
				const data = (await res.json()) as {
					message?: {
						role?: string;
						content?: string;
						tool_calls?: LocalToolCall[];
					};
				};
				responseMessage = data.message;
				toolCalls = responseMessage?.tool_calls;
			} else {
				const tempBase = baseUrl.replace(/\/+$/, '');
				const chatUrl = tempBase.endsWith('/v1') ? `${tempBase}/chat/completions` : `${tempBase}/v1/chat/completions`;
				const res = await fetch(chatUrl, {
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
				});
				if (!res.ok) {
					return {ok: false, error: `Provider error: HTTP ${res.status} ${res.statusText}`};
				}
				const data = (await res.json()) as {
					choices?: Array<{
						message?: {
							role?: string;
							content?: string;
							tool_calls?: LocalToolCall[];
						};
					}>;
				};
				responseMessage = data.choices?.[0]?.message;
				toolCalls = responseMessage?.tool_calls;
			}

			if (!responseMessage) {
				return {ok: false, error: 'Empty response from model provider.'};
			}

			latestContent = responseMessage.content || '';
			if (latestContent) {
				lastNonEmptyContent = latestContent;
			}

			if (!toolCalls || toolCalls.length === 0) {
				return {ok: true, content: latestContent};
			}

			messages.push({
				role: 'assistant',
				content: responseMessage.content || '',
				tool_calls: responseMessage.tool_calls,
			});

			for (const tc of toolCalls) {
				const toolName = tc.function?.name;
				const tool = params.tools?.find(t => t.name === toolName);

				let args: Record<string, unknown> = {};
				const rawArgs = tc.function?.arguments;
				if (typeof rawArgs === 'string') {
					try {
						args = JSON.parse(rawArgs) as Record<string, unknown>;
					} catch (e) {
						console.error(`Synapse: failed to parse arguments for tool ${toolName}:`, e);
					}
				} else if (typeof rawArgs === 'object' && rawArgs !== null) {
					args = rawArgs;
				}

				let result: string;
				if (tool) {
					if (!params.app) {
						result = `Error: Obsidian App instance is not provided to execute tool "${toolName}".`;
					} else {
						try {
							result = await tool.execute(args, params.app);
						} catch (e) {
							result = `Error executing tool "${toolName}": ${e instanceof Error ? e.message : String(e)}`;
						}
					}
				} else {
					result = `Error: Tool "${toolName}" is not available.`;
				}

				messages.push({
					role: 'tool',
					tool_call_id: tc.id || '',
					name: toolName,
					content: result,
				});
			}

			turn++;
		}

		// maxTurns exhausted without a final no-tool-call response: surface that the
		// content is truncated, falling back to the last non-empty assistant content
		// if the final turn was tool-calls-only.
		return {ok: true, content: latestContent || lastNonEmptyContent, truncated: true};
	} catch (e) {
		return {ok: false, error: `Local query failed: ${String(e)}`};
	}
}

