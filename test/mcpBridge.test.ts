import {describe, it, expect, vi} from 'vitest';
import {McpBridgeSession} from '../src/mcpBridge';

// ---------------------------------------------------------------------------
// _drainLines — private line-buffering/JSON-RPC framing logic, exercised
// directly via a hand-built "handle" object. `_drainLines` only reads/writes
// `handle.buffer` and `handle.pending` — it never touches `handle.process` —
// so a real ChildProcess is not needed to test it in isolation.
// ---------------------------------------------------------------------------

/** Mirrors the private `JsonRpcResponse` shape `_drainLines` parses and dispatches. */
interface FakeJsonRpcResponse {
	jsonrpc: '2.0';
	id: number;
	result?: unknown;
	error?: {code: number; message: string; data?: unknown};
}

interface FakeHandle {
	name: string;
	process: unknown;
	buffer: string;
	pending: Map<number, {resolve: (r: FakeJsonRpcResponse) => void; reject: (e: Error) => void}>;
}

function makeHandle(): FakeHandle {
	return {name: 'test-server', process: {}, buffer: '', pending: new Map()};
}

/** Reach into the private `_drainLines` method for direct testing. */
function drain(session: McpBridgeSession, handle: FakeHandle): void {
	(session as unknown as {_drainLines: (h: FakeHandle) => void})._drainLines(handle);
}

describe('McpBridgeSession._drainLines', () => {
	it('dispatches a single complete line to its pending request', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve = vi.fn();
		handle.pending.set(1, {resolve, reject: vi.fn()});

		handle.buffer = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n';
		drain(session, handle);

		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledWith(expect.objectContaining({id: 1, result: {ok: true}}));
		expect(handle.pending.has(1)).toBe(false);
		expect(handle.buffer).toBe('');
	});

	it('handles a JSON-RPC message split across two chunk-boundary writes', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve = vi.fn();
		handle.pending.set(1, {resolve, reject: vi.fn()});

		const full = '{"jsonrpc":"2.0","id":1,"result":{"value":42}}\n';
		const splitAt = 20;

		// First chunk arrives — no newline yet, nothing should dispatch.
		handle.buffer += full.slice(0, splitAt);
		drain(session, handle);
		expect(resolve).not.toHaveBeenCalled();
		expect(handle.buffer).toBe(full.slice(0, splitAt));

		// Second chunk completes the line.
		handle.buffer += full.slice(splitAt);
		drain(session, handle);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledWith(expect.objectContaining({id: 1, result: {value: 42}}));
		expect(handle.buffer).toBe('');
	});

	it('dispatches several complete messages that arrive in a single chunk', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve1 = vi.fn();
		const resolve2 = vi.fn();
		const resolve3 = vi.fn();
		handle.pending.set(1, {resolve: resolve1, reject: vi.fn()});
		handle.pending.set(2, {resolve: resolve2, reject: vi.fn()});
		handle.pending.set(3, {resolve: resolve3, reject: vi.fn()});

		handle.buffer =
			'{"jsonrpc":"2.0","id":1,"result":1}\n' +
			'{"jsonrpc":"2.0","id":2,"result":2}\n' +
			'{"jsonrpc":"2.0","id":3,"result":3}\n';
		drain(session, handle);

		expect(resolve1).toHaveBeenCalledWith(expect.objectContaining({id: 1, result: 1}));
		expect(resolve2).toHaveBeenCalledWith(expect.objectContaining({id: 2, result: 2}));
		expect(resolve3).toHaveBeenCalledWith(expect.objectContaining({id: 3, result: 3}));
		expect(handle.buffer).toBe('');
		expect(handle.pending.size).toBe(0);
	});

	it('drains everything when the chunk ends exactly on a newline, leaving an empty buffer', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve = vi.fn();
		handle.pending.set(1, {resolve, reject: vi.fn()});

		handle.buffer = '{"jsonrpc":"2.0","id":1,"result":"done"}\n';
		drain(session, handle);

		expect(resolve).toHaveBeenCalledTimes(1);
		expect(handle.buffer).toBe('');
	});

	it('leaves a trailing partial message (no newline yet) in the buffer undispatched', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve = vi.fn();
		handle.pending.set(1, {resolve, reject: vi.fn()});

		const partial = '{"jsonrpc":"2.0","id":1,"resul';
		handle.buffer = partial;
		drain(session, handle);

		expect(resolve).not.toHaveBeenCalled();
		expect(handle.buffer).toBe(partial);
	});

	it('drains complete lines and preserves a trailing partial line in the same call', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve = vi.fn();
		handle.pending.set(1, {resolve, reject: vi.fn()});

		const trailing = '{"jsonrpc":"2.0","id":2,"resul';
		handle.buffer = '{"jsonrpc":"2.0","id":1,"result":1}\n' + trailing;
		drain(session, handle);

		expect(resolve).toHaveBeenCalledTimes(1);
		expect(handle.buffer).toBe(trailing);
	});

	it('ignores blank lines between messages', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve = vi.fn();
		handle.pending.set(1, {resolve, reject: vi.fn()});

		handle.buffer = '\n\n{"jsonrpc":"2.0","id":1,"result":1}\n';
		drain(session, handle);

		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('silently discards a line that is not valid JSON (treated as stray noise)', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const resolve = vi.fn();
		handle.pending.set(1, {resolve, reject: vi.fn()});

		handle.buffer = 'not json at all\n{"jsonrpc":"2.0","id":1,"result":1}\n';
		expect(() => drain(session, handle)).not.toThrow();

		expect(resolve).toHaveBeenCalledTimes(1);
		expect(handle.buffer).toBe('');
	});

	it('rejects the pending request when the message carries a JSON-RPC error', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		const reject = vi.fn();
		handle.pending.set(1, {resolve: vi.fn(), reject});

		handle.buffer = '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n';
		drain(session, handle);

		expect(reject).toHaveBeenCalledTimes(1);
		const err = reject.mock.calls[0]![0] as Error;
		expect(err.message).toContain('-32601');
		expect(err.message).toContain('Method not found');
	});

	it('drops a message whose id has no matching pending request (no throw, no crash)', () => {
		const session = new McpBridgeSession();
		const handle = makeHandle();
		// No pending entry registered for id 99.
		handle.buffer = '{"jsonrpc":"2.0","id":99,"result":1}\n';
		expect(() => drain(session, handle)).not.toThrow();
		expect(handle.buffer).toBe('');
	});
});

// ---------------------------------------------------------------------------
// start() — config-file handling
// ---------------------------------------------------------------------------

describe('McpBridgeSession.start', () => {
	it('returns an empty tool list when _synapse/.mcp.json is absent', async () => {
		const session = new McpBridgeSession();
		// A path that certainly has no _synapse/.mcp.json underneath it.
		const tools = await session.start('C:/definitely-not-a-real-vault-path-xyz');
		expect(tools).toEqual([]);
		await session.stop();
	});
});
