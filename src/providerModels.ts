import {requestUrl} from 'obsidian';
import type {ModelInfo} from './agentService';

/**
 * Result of `fetchEndpointModels()` — the model-catalogue fetch for the configured local agent
 * endpoint (issue #122), also behind the Settings **Test** button. A discriminated union, so
 * callers can distinguish a reachable-but-broken endpoint (HTTP error / wrong shape) from a
 * connection failure without parsing the message.
 */
export type FetchEndpointModelsResult =
	| {ok: true; models: ModelInfo[]}
	| {ok: false; error: string; isConnectionError?: boolean};

/** A bare `/v1/models` catalogue entry, as served by a Messages-API-compatible endpoint. */
interface EndpointCatalogueListItem {
	id?: unknown;
	name?: unknown;
}

/**
 * Fetch the model catalogue of a local agent endpoint (issue #122) with ONE Obsidian
 * `requestUrl` GET to `<baseUrl>/v1/models`.
 *
 * Replaces the old OpenAI-compatible provider matrix's `fetchProviderModels()` catalogue fetch
 * (removed in #220): the same OpenAI-shaped `{data: [{id}, ...]}` response, but pointed at the
 * local agent endpoint rather than at a BYOK provider preset, and with no per-model
 * capability discovery — capability metadata died with the old catalogue, and unknown models
 * default to tool-capable per #129's unknown≠unsupported rule (the SDK path never gated on it
 * anyway).
 *
 * - **Base URL normalization**: trailing slashes and a trailing `/v1` are stripped, so a pasted
 *   `http://localhost:11434/v1` lists the same endpoint's models the agent path would query.
 * - **Credentials** use `buildEnv()`'s exact rule: a blank API key falls back to the literal
 *   `'ollama'` (Ollama requires the `x-api-key` header present but ignores its value).
 * - **Response shape** (pinned empirically against live Ollama v0.33.3): HTTP 200 with
 *   `{"object": "list", "data": [{"id": "qwen3:8b", ...}, ...]}` — mapped to `ModelInfo[]`
 *   with `id` and `name` only, no capability metadata.
 * - **`requestUrl()` rejects** (refused connection, DNS, TLS — `throw: false` only suppresses
 *   HTTP-status errors, not these) → `{ok: false, isConnectionError: true}` with a message
 *   naming the unreachable-endpoint fix (distinct from the wrong-shape failures below).
 * - **HTTP error or unparseable/wrong-shape body** → `{ok: false}` naming the failure; the
 *   catalogue is gone or the endpoint isn't serving a usable OpenAI-shaped model list.
 */
export async function fetchEndpointModels(options: {baseUrl: string; apiKey?: string}): Promise<FetchEndpointModelsResult> {
	let baseUrl = (options.baseUrl || '').trim();
	if (!baseUrl) {
		return {ok: false, error: 'Endpoint URL is required.'};
	}
	baseUrl = baseUrl.replace(/\/+$/, '');
	if (baseUrl.endsWith('/v1')) {
		baseUrl = baseUrl.slice(0, -3).replace(/\/+$/, '');
	}
	const modelsUrl = `${baseUrl}/v1/models`;

	// buildEnv()'s exact credential rule (agentService.ts): blank key → literal 'ollama'.
	const apiKey = options.apiKey?.trim() || 'ollama';

	const headers: Record<string, string> = {
		'x-api-key': apiKey,
		'anthropic-version': '2023-06-01',
	};

	try {
		const res = await requestUrl({url: modelsUrl, headers, throw: false});
		if (res.status >= 400) {
			return {ok: false, error: `HTTP ${res.status}`};
		}

		// `res.json` is an already-parsed plain value (see obsidian.d.ts RequestUrlResponse);
		// guard the access so a body the renderer couldn't parse degrades to the wrong-shape
		// path below, never a throw.
		let parsed: unknown;
		try {
			parsed = res.json;
		} catch {
			parsed = undefined;
		}
		const body = (parsed && typeof parsed === 'object')
			? parsed as {data?: unknown}
			: undefined;
		const rawModels = Array.isArray(body?.data)
			? (body.data as EndpointCatalogueListItem[])
			: Array.isArray(parsed)
				? (parsed as EndpointCatalogueListItem[])
				: [];

		const models: ModelInfo[] = [];
		for (const item of rawModels) {
			if (typeof item.id !== 'string' || !item.id) continue;
			models.push({
				id: item.id,
				name: (typeof item.name === 'string' && item.name) ? item.name : item.id,
			});
		}
		return {ok: true, models};
	} catch (e) {
		return {
			ok: false,
			error: `Could not connect to the endpoint. Make sure it is running and the URL is correct. (${e instanceof Error ? e.message : String(e)})`,
			isConnectionError: true,
		};
	}
}
