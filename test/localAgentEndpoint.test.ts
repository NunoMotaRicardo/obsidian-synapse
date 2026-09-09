import {describe, it, expect, beforeEach, vi} from 'vitest';
import {requestUrl} from 'obsidian';
import {
	testLocalAgentEndpoint,
	type TestLocalAgentEndpointResult,
} from '../src/providerModels';

// ---------------------------------------------------------------------------
// Local agent endpoint Test button (issue #223) — `testLocalAgentEndpoint()`
// probes `<baseUrl>/v1/messages` with Anthropic-protocol headers to verify the
// endpoint configured under "Local agent endpoint (advanced)" (issue #122)
// actually speaks the Anthropic Messages API, BEFORE the user finds out the
// hard way mid-conversation.
//
// All response shapes below were pinned against a live Ollama v0.33.3
// (2026-09-09):
//   - POST /v1/messages, installed model → 200 + {type: 'message', id, ...}
//   - POST /v1/messages, unknown model  → 404 + {type: 'error',
//     error: {type: 'not_found_error', message: "model 'x' not found"}}
//   - model field omitted                → 400 + {type: 'error',
//     error: {type: 'invalid_request_error', message: 'model is required'}}
// The probe must NOT depend on its fixed probe model being installed — an
// Anthropic-shaped error answer still proves the Messages API is present, so
// that case is a pass-with-note, not a failure.
// ---------------------------------------------------------------------------

const mockedRequestUrl = vi.mocked(requestUrl);

interface MockResponse {
	status: number;
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

// Obsidian's RequestUrlResponse exposes `json`/`text`/`arrayBuffer` as
// already-resolved plain values (see obsidian.d.ts RequestUrlResponse), not
// methods like `fetch()`'s Response — providerModels.ts reads `res.json`
// directly. Same helper as test/providerModels.test.ts.
function jsonResponse(status: number, body: unknown): MockResponse {
	return {status, json: body, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0), headers: {}};
}

beforeEach(() => {
	mockedRequestUrl.mockReset();
	mockedRequestUrl.mockImplementation(((request: unknown) => {
		return Promise.resolve(jsonResponse(404, {}));
	}) as typeof requestUrl);
});

/** The one probe request a Test click should ever issue, as a typed shape. */
interface ProbeCall {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

function probeCalls(): ProbeCall[] {
	return mockedRequestUrl.mock.calls.map(([opts]) => opts as ProbeCall);
}

describe('testLocalAgentEndpoint (issue #223)', () => {
	it('round-trips the Messages API: posts /v1/messages with Anthropic-protocol headers and a tiny max_tokens, and passes on {type: "message"}', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.resolve(jsonResponse(200, {
				type: 'message',
				id: 'msg_probe123',
				role: 'assistant',
				content: [{type: 'text', text: 'pong'}],
				stop_reason: 'max_tokens',
			}));
		}) as typeof requestUrl);

		const res = await testLocalAgentEndpoint({baseUrl: 'http://localhost:11434'});
		expect(res).toEqual({ok: true, messageId: 'msg_probe123'});

		const calls = probeCalls();
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe('http://localhost:11434/v1/messages');
		expect(call?.method).toBe('POST');
		expect(call?.headers?.['x-api-key']).toBe('ollama');
		expect(call?.headers?.['anthropic-version']).toBe('2023-06-01');
		expect(call?.headers?.['Content-Type']).toBe('application/json');

		const body = JSON.parse(call?.body || '{}') as {
			model?: string;
			max_tokens?: number;
			messages?: Array<{role: string; content: string}>;
		};
		expect(typeof body.model).toBe('string');
		expect(body.model?.length).toBeGreaterThan(0);
		expect(body.max_tokens).toBeLessThanOrEqual(32);
		expect(body.messages?.[0]?.role).toBe('user');
	});

	it('sends the configured API key when one is set (validating the exact credentials the agent path uses)', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.resolve(jsonResponse(200, {type: 'message', id: 'msg_probe456'}));
		}) as typeof requestUrl);

		const res = await testLocalAgentEndpoint({baseUrl: 'http://localhost:11434', apiKey: 'sk-endpoint-key'});
		expect(res).toEqual({ok: true, messageId: 'msg_probe456'});

		const headers = probeCalls()[0]?.headers || {};
		expect(headers['x-api-key']).toBe('sk-endpoint-key');
	});

	it('falls back to the literal "ollama" API key when blank — the same rule as buildEnv()', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.resolve(jsonResponse(200, {type: 'message', id: 'msg_probe789'}));
		}) as typeof requestUrl);

		await testLocalAgentEndpoint({baseUrl: 'http://localhost:11434', apiKey: '  '});

		const headers = probeCalls()[0]?.headers || {};
		expect(headers['x-api-key']).toBe('ollama');
	});

	it('normalizes a trailing /v1 and trailing slashes the same way fetchProviderModels does for ollama', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.resolve(jsonResponse(200, {type: 'message', id: 'msg_probe0'}));
		}) as typeof requestUrl);

		const res = await testLocalAgentEndpoint({baseUrl: 'http://localhost:11434/v1/'});
		expect(res.ok).toBe(true);
		expect(probeCalls()[0]?.url).toBe('http://localhost:11434/v1/messages');
	});

	it('treats an Anthropic-shaped error answer (e.g. probe model not installed) as reachable-and-API-shaped, not a failure', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.resolve(jsonResponse(404, {
				type: 'error',
				error: {type: 'not_found_error', message: "model 'qwen3:8b' not found"},
			}));
		}) as typeof requestUrl);

		const res = await testLocalAgentEndpoint({baseUrl: 'http://localhost:11434'});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.messageId).toBeUndefined();
		expect(res.note).toContain('not_found_error');
		expect(res.note).toContain("model 'qwen3:8b' not found");
	});

	it('reports a connection failure as unreachable, distinguishing it from shape errors', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'));
		}) as typeof requestUrl);

		const res = await testLocalAgentEndpoint({baseUrl: 'http://localhost:59999'});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.isConnectionError).toBe(true);
		expect(res.error).toContain('Could not connect');
	});

	it('reports an HTTP error in a non-Anthropic shape as a wrong-shape failure, not a connection failure', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.resolve(jsonResponse(500, {error: {message: 'internal'}}));
		}) as typeof requestUrl);

		const res = await testLocalAgentEndpoint({baseUrl: 'http://localhost:11434'});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.isConnectionError).toBeUndefined();
		expect(res.error).toContain('HTTP 500');
	});

	it('reports a 200 whose body is not Messages API shaped as a wrong-shape failure', async () => {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'pong'}}]}));
		}) as typeof requestUrl);

		const res = await testLocalAgentEndpoint({baseUrl: 'http://localhost:11434'});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.isConnectionError).toBeUndefined();
		expect(res.error).toContain('not a Messages API shape');
	});

	it('returns without any network request when the base URL is blank', async () => {
		const res = await testLocalAgentEndpoint({baseUrl: ''});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toBe('Endpoint URL is required.');
		expect(mockedRequestUrl).not.toHaveBeenCalled();
	});

	it('does not hang the Test button on a dead-but-accepting host: caps the probe at a timeout', async () => {
		// requestUrl has no AbortSignal — the helper races the request against a timer.
		// Mock a request that never resolves; with real timers the 10s cap would make the
		// test slow, so drive it with fake timers and advance past the cap.
		vi.useFakeTimers();
		try {
			mockedRequestUrl.mockImplementation(((request: unknown) => {
				return new Promise(() => {
					// never settles — dead-but-accepting host
				});
			}) as typeof requestUrl);

			const pending = testLocalAgentEndpoint({baseUrl: 'http://localhost:11434'});
			// Resolve the race's timer without actually waiting 10s.
			await vi.advanceTimersByTimeAsync(10_000);
			const res = await pending;

			expect(res.ok).toBe(false);
			if (res.ok) return;
			expect(res.error).toContain('Timed out');
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Type-level lock on the result union: the settings handler branches on
// `messageId` (full success) vs `note` (Anthropic-shaped error answer), and on
// `error`/`isConnectionError` for failures. This compile-time-only assertion
// keeps future edits to the union from silently breaking that discrimination.
// ---------------------------------------------------------------------------
describe('TestLocalAgentEndpointResult type', () => {
	it('discriminates the union as used by the settings handler', () => {
		const success: TestLocalAgentEndpointResult = {ok: true, messageId: 'msg_1'};
		const noted: TestLocalAgentEndpointResult = {ok: true, note: 'The endpoint replied with an Anthropic error (not_found_error — …).'};
		const failed: TestLocalAgentEndpointResult = {ok: false, error: 'Could not connect to the endpoint. …', isConnectionError: true};
		const plainFail: TestLocalAgentEndpointResult = {ok: false, error: 'HTTP 500 — …'};

		if (success.ok) expect(success.messageId).toBe('msg_1');
		if (noted.ok) expect(noted.note).toBeTruthy();
		if (!failed.ok) expect(failed.isConnectionError).toBe(true);
		if (!plainFail.ok) expect(plainFail.isConnectionError).toBeUndefined();
	});
});