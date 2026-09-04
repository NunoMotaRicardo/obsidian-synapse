import {describe, it, expect, beforeEach, vi} from 'vitest';
import {requestUrl} from 'obsidian';
import {AgentService, Session, type SessionConfig, type SessionEvent, type PermissionResult} from '../src/agentService';
import {executeLocalProviderQuery, isLoopbackEndpoint, type LocalTool} from '../src/providerModels';

// ---------------------------------------------------------------------------
// Issue #138 — local models in the chat panel previously got no `tools` at all
// (`Session.send()`'s local-model branch never passed `params.tools` to
// `executeLocalProviderQuery`), so the ReAct loop degenerated to a single
// completion. Two things had to be true before wiring tools into chat:
//
//   1. Tool execution needed an approval gate — the trigger path
//      (`triggerExecutor.ts`) runs unattended by design, but `Session.send()`
//      serves the interactive chat panel, which already gates the real Agent
//      SDK path via `canUseTool`/`ToolApprovalModal`.
//   2. Tools should only be offered to a model whose catalogue doesn't say
//      "no tools" — the same `supportsTools !== false` test triggers use.
//
// This file covers both: the approval gate itself (in `providerModels.ts`,
// since that's where the tool-execution loop lives) and the capability gate
// + `canUseTool` adapter wiring (in `agentService.ts#Session.send()`).
// ---------------------------------------------------------------------------

const mockedRequestUrl = vi.mocked(requestUrl);

interface MockResponse {
	status: number;
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): MockResponse {
	return {status, json: body, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0), headers: {}};
}

beforeEach(() => {
	mockedRequestUrl.mockReset();
});

// ---------------------------------------------------------------------------
// isLoopbackEndpoint — labels the approval prompt (#138): a loopback base URL
// (Ollama's default) never leaves the machine; anything else (BYOK remote
// providers — OpenAI, Azure, OpenRouter, ...) does.
// ---------------------------------------------------------------------------
describe('isLoopbackEndpoint', () => {
	it('treats localhost/127.0.0.1/::1 as loopback', () => {
		expect(isLoopbackEndpoint('http://localhost:11434')).toBe(true);
		expect(isLoopbackEndpoint('http://127.0.0.1:11434')).toBe(true);
		expect(isLoopbackEndpoint('http://[::1]:11434')).toBe(true);
	});

	it('treats a remote BYOK endpoint as non-loopback', () => {
		expect(isLoopbackEndpoint('https://openrouter.ai/api')).toBe(false);
		expect(isLoopbackEndpoint('https://my-res.openai.azure.com/openai')).toBe(false);
		expect(isLoopbackEndpoint('https://api.openai.com/v1')).toBe(false);
	});

	it('treats an unparseable URL as non-loopback (the more cautious label)', () => {
		expect(isLoopbackEndpoint('not a url')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// executeLocalProviderQuery's approval gate (#138)
// ---------------------------------------------------------------------------
describe('executeLocalProviderQuery — tool approval gate', () => {
	function makeToolCallThenFinalMock(toolName: string, finalContent = 'done'): void {
		let call = 0;
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				call++;
				if (call === 1) {
					return Promise.resolve(jsonResponse(200, {
						choices: [{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [{id: 'call_1', type: 'function', function: {name: toolName, arguments: '{}'}}],
							},
						}],
					}));
				}
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: finalContent}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);
	}

	function makeSpyTool(name: string): {tool: LocalTool; execute: ReturnType<typeof vi.fn>} {
		const execute = vi.fn().mockResolvedValue('tool result content');
		return {
			tool: {name, description: 'a test tool', parameters: {type: 'object', properties: {}}, execute},
			execute,
		};
	}

	it('consults onApproveTool before tool.execute runs', async () => {
		makeToolCallThenFinalMock('read_note');
		const callOrder: string[] = [];

		const onApproveTool = vi.fn(async () => {
			callOrder.push('approve');
			return {allow: true};
		});
		const execute = vi.fn(async (): Promise<string> => {
			callOrder.push('execute');
			return 'tool result content';
		});
		const tool: LocalTool = {name: 'read_note', description: 'a test tool', parameters: {type: 'object', properties: {}}, execute};

		const result = await executeLocalProviderQuery(
			{preset: 'openai', baseUrl: 'http://localhost:9999'},
			{prompt: 'read a note', model: 'test-model', tools: [tool], app: {} as never, onApproveTool}
		);

		expect(result.ok).toBe(true);
		expect(onApproveTool).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(callOrder).toEqual(['approve', 'execute']);
	});

	it('does not execute the tool when approval is denied, and returns a sensible message to the model instead of erroring', async () => {
		makeToolCallThenFinalMock('read_note');
		const {tool, execute} = makeSpyTool('read_note');

		const onApproveTool = vi.fn().mockResolvedValue({allow: false, message: 'Denied by user'});

		const result = await executeLocalProviderQuery(
			{preset: 'openai', baseUrl: 'http://localhost:9999'},
			{prompt: 'read a note', model: 'test-model', tools: [tool], app: {} as never, onApproveTool}
		);

		expect(result.ok).toBe(true);
		// The tool must never have actually run.
		expect(execute).not.toHaveBeenCalled();

		// The model still receives a `tool` role message (not a thrown error, not a
		// silently dropped turn) explaining the call was declined — the second request
		// (the follow-up turn after the tool "result") carries it in the messages array.
		const secondCall = mockedRequestUrl.mock.calls[1]?.[0] as {body?: string} | undefined;
		const body = JSON.parse(secondCall?.body || '{}') as {messages?: Array<{role: string; content?: string}>};
		const toolResultMsg = body.messages?.find(m => m.role === 'tool');
		expect(toolResultMsg?.content).toContain('not approved');
		expect(toolResultMsg?.content).toContain('Denied by user');
	});

	it('includes the endpoint (and whether it is remote) in the context handed to onApproveTool', async () => {
		makeToolCallThenFinalMock('read_note');
		const {tool} = makeSpyTool('read_note');
		const onApproveTool = vi.fn().mockResolvedValue({allow: true});

		await executeLocalProviderQuery(
			{preset: 'openai', baseUrl: 'https://openrouter.ai/api'},
			{prompt: 'read a note', model: 'test-model', tools: [tool], app: {} as never, onApproveTool}
		);

		expect(onApproveTool).toHaveBeenCalledWith(
			'read_note',
			expect.any(Object),
			expect.objectContaining({endpoint: 'https://openrouter.ai/api', isRemoteEndpoint: true})
		);
	});

	it('labels a loopback endpoint as not remote in the approval context', async () => {
		let call = 0;
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/api/chat')) {
				call++;
				if (call === 1) {
					return Promise.resolve(jsonResponse(200, {
						message: {
							role: 'assistant',
							content: '',
							tool_calls: [{id: 'call_1', type: 'function', function: {name: 'read_note', arguments: '{}'}}],
						},
					}));
				}
				return Promise.resolve(jsonResponse(200, {message: {role: 'assistant', content: 'done'}}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const {tool} = makeSpyTool('read_note');
		const onApproveTool = vi.fn().mockResolvedValue({allow: true});

		await executeLocalProviderQuery(
			{preset: 'ollama', baseUrl: 'http://localhost:11434'},
			{prompt: 'read a note', model: 'test-model', tools: [tool], app: {} as never, onApproveTool}
		);

		expect(onApproveTool).toHaveBeenCalledWith(
			'read_note',
			expect.any(Object),
			expect.objectContaining({endpoint: 'http://localhost:11434', isRemoteEndpoint: false})
		);
	});

	it('runs the tool directly with no gate when onApproveTool is omitted (unchanged trigger-path behaviour)', async () => {
		makeToolCallThenFinalMock('read_note');
		const {tool, execute} = makeSpyTool('read_note');

		const result = await executeLocalProviderQuery(
			{preset: 'openai', baseUrl: 'http://localhost:9999'},
			{prompt: 'read a note', model: 'test-model', tools: [tool], app: {} as never}
		);

		expect(result.ok).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('fails closed: an onApproveTool that throws is treated as a denial, not a silent allow', async () => {
		makeToolCallThenFinalMock('read_note');
		const {tool, execute} = makeSpyTool('read_note');
		const onApproveTool = vi.fn().mockRejectedValue(new Error('modal blew up'));

		const result = await executeLocalProviderQuery(
			{preset: 'openai', baseUrl: 'http://localhost:9999'},
			{prompt: 'read a note', model: 'test-model', tools: [tool], app: {} as never, onApproveTool}
		);

		expect(result.ok).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Session.send()'s local-model branch (#138) — capability gate and the
// canUseTool -> LocalToolApprovalHandler adapter.
// ---------------------------------------------------------------------------
describe('Session#send — local-model tool wiring', () => {
	function makeService(): AgentService {
		return new AgentService({providerConfig: {preset: 'openai', baseUrl: 'http://localhost:9999'}});
	}

	function collectMessages(session: Session): SessionEvent[] {
		const events: SessionEvent[] = [];
		session.on('assistant.message', (e) => events.push(e));
		session.on('session.error', (e) => events.push(e));
		return events;
	}

	function mockPlainCompletion(content = 'no tools used'): void {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);
	}

	it('does not offer tools to a model the catalogue says cannot call them (supportsTools: false)', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'no-tools-model', name: 'No Tools Model', supportsTools: false}]);
		mockPlainCompletion();

		const config: SessionConfig = {model: 'no-tools-model'};
		const session = new Session(service, config);
		collectMessages(session);
		await session.send({prompt: 'hi', app: {vault: {getFiles: () => []}} as never});

		const call = mockedRequestUrl.mock.calls.find(([opts]) => (opts as {url: string}).url.endsWith('/v1/chat/completions'));
		const body = JSON.parse((call?.[0] as {body?: string})?.body || '{}') as {tools?: unknown};
		expect(body.tools).toBeUndefined();
	});

	it('offers tools to a model with no capability info (unknown defaults to allowed, same test as triggerExecutor.ts)', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'unknown-caps-model', name: 'Unknown Caps Model'}]);
		mockPlainCompletion();

		const config: SessionConfig = {model: 'unknown-caps-model'};
		const session = new Session(service, config);
		collectMessages(session);
		await session.send({prompt: 'hi', app: {vault: {getFiles: () => []}} as never});

		const call = mockedRequestUrl.mock.calls.find(([opts]) => (opts as {url: string}).url.endsWith('/v1/chat/completions'));
		const body = JSON.parse((call?.[0] as {body?: string})?.body || '{}') as {tools?: Array<{function?: {name?: string}}>};
		expect(body.tools?.length).toBeGreaterThan(0);
		expect(body.tools?.some(t => t.function?.name === 'list_notes')).toBe(true);
	});

	it('adapts the session\'s existing canUseTool (ToolApprovalModal/permissionHandler) into the local approval gate, naming the endpoint', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'tool-model', name: 'Tool Model'}]);

		let call = 0;
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				call++;
				if (call === 1) {
					return Promise.resolve(jsonResponse(200, {
						choices: [{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [{id: 'call_1', type: 'function', function: {name: 'list_notes', arguments: '{}'}}],
							},
						}],
					}));
				}
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'done'}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const canUseTool = vi.fn().mockImplementation(async (): Promise<PermissionResult> => {
			return {behavior: 'allow', updatedInput: {}};
		});

		const getFiles = vi.fn().mockReturnValue([]);
		const config: SessionConfig = {model: 'tool-model', canUseTool};
		const session = new Session(service, config);
		collectMessages(session);
		await session.send({prompt: 'list my notes', app: {vault: {getFiles}} as never});

		expect(canUseTool).toHaveBeenCalledTimes(1);
		const [toolName, , options] = canUseTool.mock.calls[0] as [string, Record<string, unknown>, {description?: string}];
		expect(toolName).toBe('list_notes');
		// The prompt must name the endpoint the call is going to (#138 decision comment).
		expect(options.description).toContain('http://localhost:9999');
		expect(getFiles).toHaveBeenCalledTimes(1);
	});

	it('denies the tool call when canUseTool returns deny, and the vault tool never runs', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'tool-model', name: 'Tool Model'}]);

		let call = 0;
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				call++;
				if (call === 1) {
					return Promise.resolve(jsonResponse(200, {
						choices: [{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [{id: 'call_1', type: 'function', function: {name: 'list_notes', arguments: '{}'}}],
							},
						}],
					}));
				}
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'ok, declined'}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const canUseTool = vi.fn().mockResolvedValue({behavior: 'deny', message: 'Denied by user'} satisfies PermissionResult);
		const getFiles = vi.fn().mockReturnValue([]);
		const config: SessionConfig = {model: 'tool-model', canUseTool};
		const session = new Session(service, config);
		collectMessages(session);
		await session.send({prompt: 'list my notes', app: {vault: {getFiles}} as never});

		expect(getFiles).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AgentService#inlineChat's local-model branch (#150) — applies the same
// capability gate and canUseTool -> LocalToolApprovalHandler adapter #138 gave
// Session#send() to the second call site (editor actions/edit modal/search).
// Unlike Session#send(), reachability also requires `canUseTool`: inlineChat
// callers are one-shot rather than an attended conversation, so there is no
// "unattended by design" precedent to fall back to running tools ungated —
// see the method's doc comment in agentService.ts.
// ---------------------------------------------------------------------------
describe('AgentService#inlineChat — local-model tool wiring', () => {
	// `ensureConnected()` runs before the local-model branch and validates that
	// `claudeLocation` exists on disk — point it at the running Node binary
	// (guaranteed to exist) rather than a real Claude CLI install, which the
	// local-model branch never touches.
	function makeService(): AgentService {
		return new AgentService({
			providerConfig: {preset: 'openai', baseUrl: 'http://localhost:9999'},
			claudeLocation: process.execPath,
		});
	}

	function mockPlainCompletion(content = 'no tools used'): void {
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);
	}

	it('does not offer tools to a model the catalogue says cannot call them (supportsTools: false)', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'no-tools-model', name: 'No Tools Model', supportsTools: false}]);
		mockPlainCompletion();

		const canUseTool = vi.fn().mockResolvedValue({behavior: 'allow', updatedInput: {}} satisfies PermissionResult);
		await service.inlineChat({
			prompt: 'hi',
			model: 'no-tools-model',
			app: {vault: {getFiles: () => []}} as never,
			canUseTool,
		});

		const call = mockedRequestUrl.mock.calls.find(([opts]) => (opts as {url: string}).url.endsWith('/v1/chat/completions'));
		const body = JSON.parse((call?.[0] as {body?: string})?.body || '{}') as {tools?: unknown};
		expect(body.tools).toBeUndefined();
	});

	it('does not offer tools when no App instance is supplied, and does not crash', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'tool-model', name: 'Tool Model'}]);
		mockPlainCompletion();

		const canUseTool = vi.fn().mockResolvedValue({behavior: 'allow', updatedInput: {}} satisfies PermissionResult);
		const result = await service.inlineChat({prompt: 'hi', model: 'tool-model', canUseTool});

		expect(result.content).toBe('no tools used');
		const call = mockedRequestUrl.mock.calls.find(([opts]) => (opts as {url: string}).url.endsWith('/v1/chat/completions'));
		const body = JSON.parse((call?.[0] as {body?: string})?.body || '{}') as {tools?: unknown};
		expect(body.tools).toBeUndefined();
	});

	it('does not offer tools when no canUseTool is supplied, even with an App instance (fails closed rather than running ungated)', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'tool-model', name: 'Tool Model'}]);
		mockPlainCompletion();

		const result = await service.inlineChat({
			prompt: 'hi',
			model: 'tool-model',
			app: {vault: {getFiles: () => []}} as never,
		});

		expect(result.content).toBe('no tools used');
		const call = mockedRequestUrl.mock.calls.find(([opts]) => (opts as {url: string}).url.endsWith('/v1/chat/completions'));
		const body = JSON.parse((call?.[0] as {body?: string})?.body || '{}') as {tools?: unknown};
		expect(body.tools).toBeUndefined();
	});

	it('offers tools, and adapts canUseTool into the approval gate naming the endpoint, when both app and canUseTool are supplied', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'tool-model', name: 'Tool Model'}]);

		let call = 0;
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				call++;
				if (call === 1) {
					return Promise.resolve(jsonResponse(200, {
						choices: [{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [{id: 'call_1', type: 'function', function: {name: 'list_notes', arguments: '{}'}}],
							},
						}],
					}));
				}
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'done'}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const canUseTool = vi.fn().mockImplementation(async (): Promise<PermissionResult> => {
			return {behavior: 'allow', updatedInput: {}};
		});
		const getFiles = vi.fn().mockReturnValue([]);

		const result = await service.inlineChat({
			prompt: 'list my notes',
			model: 'tool-model',
			app: {vault: {getFiles}} as never,
			canUseTool,
		});

		expect(result.content).toBe('done');
		expect(canUseTool).toHaveBeenCalledTimes(1);
		const [toolName, , options] = canUseTool.mock.calls[0] as [string, Record<string, unknown>, {description?: string}];
		expect(toolName).toBe('list_notes');
		// The approval prompt must name the endpoint the call is going to (#138 decision comment,
		// reused here rather than re-implemented — #150).
		expect(options.description).toContain('http://localhost:9999');
		expect(getFiles).toHaveBeenCalledTimes(1);
	});

	it('denies the tool call when canUseTool returns deny, and the vault tool never runs', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'tool-model', name: 'Tool Model'}]);

		let call = 0;
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				call++;
				if (call === 1) {
					return Promise.resolve(jsonResponse(200, {
						choices: [{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [{id: 'call_1', type: 'function', function: {name: 'list_notes', arguments: '{}'}}],
							},
						}],
					}));
				}
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'ok, declined'}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const canUseTool = vi.fn().mockResolvedValue({behavior: 'deny', message: 'Denied by user'} satisfies PermissionResult);
		const getFiles = vi.fn().mockReturnValue([]);

		await service.inlineChat({
			prompt: 'list my notes',
			model: 'tool-model',
			app: {vault: {getFiles}} as never,
			canUseTool,
		});

		expect(getFiles).not.toHaveBeenCalled();
	});
});
