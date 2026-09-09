import {requestUrl} from 'obsidian';
import type {ModelInfo} from './agentService';

/**
 * Result of `fetchEndpointModels()` — the model-catalogue fetch for the configured local agent
 * endpoint (issue #122). A discriminated union in the same shape as
 * `testLocalAgentEndpoint()`'s result, so callers can distinguish a reachable-but-broken
 * endpoint (HTTP error / wrong shape) from a connection failure without parsing the message.
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
 * - **Base URL normalization** matches `testLocalAgentEndpoint()`: trailing slashes and a
 *   trailing `/v1` are stripped, so a pasted `http://localhost:11434/v1` lists the same
 *   endpoint's models the agent path would query.
 * - **Credentials** use `buildEnv()`'s exact rule: a blank API key falls back to the literal
 *   `'ollama'` (Ollama requires the `x-api-key` header present but ignores its value).
 * - **Response shape** (pinned empirically against live Ollama v0.33.3): HTTP 200 with
 *   `{"object": "list", "data": [{"id": "qwen3:8b", ...}, ...]}` — mapped to `ModelInfo[]`
 *   with `id` and `name` only, no capability metadata.
 * - **`requestUrl()` rejects** (refused connection, DNS, TLS — `throw: false` only suppresses
 *   HTTP-status errors, not these) → `{ok: false, isConnectionError: true}` with a message
 *   naming the unreachable-endpoint fix — mirroring `testLocalAgentEndpoint()`'s
 *   connection-vs-shape distinction.
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

/**
 * Result of `testLocalAgentEndpoint()` (issue #223) — the probe behind the **Local agent
 * endpoint (advanced)** settings section's Test button. A discriminated union in the same
 * shape as `FetchEndpointModelsResult`, so the settings handler can show a specific
 * failure Notice (AC-4) instead of a bare thrown error.
 */
export type TestLocalAgentEndpointResult =
	| {ok: true; messageId?: string; note?: string}
	| {ok: false; error: string; isConnectionError?: boolean};
/**
 * Fixed model id for `testLocalAgentEndpoint()`'s probe request. Deliberately a fixed
 * well-known Ollama tag rather than the user's configured model: the probe must not depend
 * on any specific model being *installed* — an endpoint that answers the Messages API with
 * an Anthropic-shaped "model not found" error has still proven the thing the Test button
 * exists to verify (see `testLocalAgentEndpoint()`). Empirically, Ollama v0.33.3 completes a
 * 16-token request for an installed `qwen3:8b` in well under a second.
 */
const LOCAL_AGENT_ENDPOINT_PROBE_MODEL = 'qwen3:8b';

/**
 * Timeout for `testLocalAgentEndpoint()`'s single probe request. `requestUrl()` has no
 * AbortSignal, so the timeout is a `Promise.race` that stops *waiting* (the request itself
 * may still complete in the background — harmless for a 16-token probe) — a dead-but-accepting
 * host must not hang the Test button.
 */
const LOCAL_AGENT_ENDPOINT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Verifies that a configured local agent endpoint (issue #122) actually speaks the Anthropic
 * Messages API, for the **Local agent endpoint (advanced)** settings section's Test button
 * (issue #223). Performs ONE Obsidian `requestUrl` POST to `<baseUrl>/v1/messages` with the
 * same Anthropic-protocol headers the CLI's Messages API client sends (`x-api-key` /
 * `anthropic-version`) and a minimal 1-turn user message with `max_tokens: 16`, then
 * classifies the outcome:
 *
 * - **200 + `{type: 'message', ...}`** → `{ok: true, messageId}` — the endpoint completed a
 *   real Messages API round trip.
 * - **Any HTTP status + an Anthropic error envelope (`{type: 'error', error: {...}}`)** →
 *   `{ok: true, note}` — the Messages API itself *answered*: the endpoint understood the
 *   request well enough to reject it in Anthropic's own error shape. The probe model needn't
 *   be installed for this to happen (a 404 "model not found" is the expected reply on an
 *   endpoint without `qwen3:8b`), so this is a pass with the endpoint's own message carried
 *   in `note`, not a failure.
 * - **`requestUrl` rejects** (network-level: refused connection, DNS, TLS — `throw: false`
 *   only suppresses HTTP-status errors, not these) → `{ok: false, isConnectionError: true}`
 *   with a message naming the unreachable-endpoint fix, mirroring how
 *   `fetchEndpointModels()` marks `isConnectionError`.
 * - **Timeout** → `{ok: false}` naming the timeout.
 * - **HTTP error or 200 in a non-Anthropic shape** (e.g. an OpenAI-compatible server's own
 *   error JSON, or a `/v1/chat/completions`-style body) → `{ok: false}` naming the
 *   wrong-shape response — the endpoint answered, but it does not speak the Messages API.
 *
 * Base URL normalization matches `fetchEndpointModels()`: trailing slashes and a trailing
 * `/v1` are stripped, so a pasted `http://localhost:11434/v1` probes the same
 * `<host>/v1/messages` path the agent path (`buildEnv()`'s `ANTHROPIC_BASE_URL` → the CLI's
 * Messages API client) would hit. The API key uses `buildEnv()`'s exact rule — a blank key
 * falls back to the literal `'ollama'` (Ollama requires the header present but ignores its
 * value) — so the probe validates the exact credentials the agent path will send (AC-5).
 * Read-only aside from the one probe request: no settings write, no service re-init, no CLI
 * subprocess (AC-6). Response shapes pinned against live Ollama v0.33.3 (2026-09-09).
 */
export async function testLocalAgentEndpoint(options: {baseUrl: string; apiKey?: string}): Promise<TestLocalAgentEndpointResult> {
	let baseUrl = (options.baseUrl || '').trim();
	if (!baseUrl) {
		return {ok: false, error: 'Endpoint URL is required.'};
	}
	baseUrl = baseUrl.replace(/\/+$/, '');
	if (baseUrl.endsWith('/v1')) {
		baseUrl = baseUrl.slice(0, -3).replace(/\/+$/, '');
	}
	const messagesUrl = `${baseUrl}/v1/messages`;

	// buildEnv()'s exact credential rule (agentService.ts): blank key → literal 'ollama'.
	const apiKey = options.apiKey?.trim() || 'ollama';

	const headers: Record<string, string> = {
		'x-api-key': apiKey,
		'anthropic-version': '2023-06-01',
		'Content-Type': 'application/json',
	};
	const requestBody = JSON.stringify({
		model: LOCAL_AGENT_ENDPOINT_PROBE_MODEL,
		max_tokens: 16,
		messages: [{role: 'user', content: 'ping'}],
	});

	let timedOut = false;
	let timer: number | undefined;
	try {
		const res = await Promise.race([
			requestUrl({url: messagesUrl, method: 'POST', headers, body: requestBody, throw: false}),
			new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => {
					timedOut = true;
					reject(new Error('probe timeout'));
				}, LOCAL_AGENT_ENDPOINT_PROBE_TIMEOUT_MS);
			}),
		]);

		// `res.json` is an already-parsed plain value (not a method — see
		// obsidian.d.ts RequestUrlResponse); guard the access anyway so a body the
		// renderer couldn't parse degrades to the wrong-shape path below, never a throw.
		let parsed: unknown;
		try {
			parsed = res.json;
		} catch {
			parsed = undefined;
		}
		const body = (parsed && typeof parsed === 'object')
			? parsed as {type?: unknown; id?: unknown; error?: {type?: unknown; message?: unknown}}
			: undefined;

		if (body?.type === 'error') {
			const errType = typeof body.error?.type === 'string' ? body.error.type : '';
			const errMsg = typeof body.error?.message === 'string' ? body.error.message : '';
			const detail = [errType, errMsg].filter(Boolean).join(' — ');
			return {
				ok: true,
				note: `The endpoint replied with an Anthropic error${detail ? ` (${detail})` : ''}.`,
			};
		}

		if (body?.type === 'message') {
			return {ok: true, messageId: typeof body.id === 'string' ? body.id : undefined};
		}

		if (res.status >= 400) {
			return {ok: false, error: `HTTP ${res.status} — the endpoint answered but not in Messages API shape.`};
		}
		return {ok: false, error: `The endpoint answered (HTTP ${res.status}) but the response was not a Messages API shape.`};
	} catch (e) {
		if (timedOut) {
			return {ok: false, error: `Timed out after ${LOCAL_AGENT_ENDPOINT_PROBE_TIMEOUT_MS}ms — the endpoint did not answer the probe.`};
		}
		return {
			ok: false,
			error: `Could not connect to the endpoint. Make sure it is running and the URL is correct. (${e instanceof Error ? e.message : String(e)})`,
			isConnectionError: true,
		};
	} finally {
		if (timer !== undefined) {
			window.clearTimeout(timer);
		}
	}
}