/**
 * MCP Bridge — spawns stdio MCP servers discovered from `_synapse/.mcp.json`,
 * negotiates JSON-RPC `initialize` + `tools/list`, and wraps the discovered
 * tools as `LocalTool` instances for the local-model ReAct loop.
 *
 * One `McpBridgeSession` is created per trigger execution. The caller:
 *   1. `await session.start(vaultBasePath)` → gets `LocalTool[]`
 *   2. runs the ReAct loop with the returned tools merged with vault tools
 *   3. `await session.stop()` in a finally block to kill all spawned processes
 */

import {spawn} from 'child_process';
import type {ChildProcessWithoutNullStreams} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {App} from 'obsidian';
import type {LocalTool} from './providerModels';
import {SYNAPSE_FOLDER} from './vaultPaths';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

interface McpConfig {
	mcpServers?: Record<string, McpServerConfig>;
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number;
	result?: unknown;
	error?: {code: number; message: string; data?: unknown};
}

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-server handle
// ---------------------------------------------------------------------------

interface ServerHandle {
	name: string;
	process: ChildProcessWithoutNullStreams;
	/** Lines received from stdout that haven't yet been matched to a request. */
	buffer: string;
	/** Map from request id → resolve/reject for pending requests. */
	pending: Map<number, {resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void}>;
}

// ---------------------------------------------------------------------------
// McpBridgeSession
// ---------------------------------------------------------------------------

export class McpBridgeSession {
	private servers: ServerHandle[] = [];
	private nextId = 1;

	/**
	 * Read `_synapse/.mcp.json` from the vault at `vaultBasePath`, spawn all
	 * configured MCP servers, negotiate `initialize` + `tools/list` for each,
	 * and return a flat `LocalTool[]` wrapping every discovered tool.
	 *
	 * If the config file is absent or empty, returns an empty array (graceful).
	 * Individual server errors are caught and logged — other servers continue.
	 */
	async start(vaultBasePath: string): Promise<LocalTool[]> {
		const configPath = path.join(vaultBasePath, SYNAPSE_FOLDER, '.mcp.json');

		let config: McpConfig;
		try {
			const raw = fs.readFileSync(configPath, 'utf8');
			config = JSON.parse(raw) as McpConfig;
		} catch {
			// Config absent or unreadable — nothing to bridge
			return [];
		}

		const serverEntries = Object.entries(config.mcpServers ?? {});
		if (serverEntries.length === 0) {
			return [];
		}

		const allTools: LocalTool[] = [];

		for (const [serverName, serverCfg] of serverEntries) {
			try {
				const tools = await this._startServer(serverName, serverCfg);
				allTools.push(...tools);
			} catch (e) {
				console.error(`[synapse] MCP bridge: failed to start server "${serverName}":`, e);
			}
		}

		return allTools;
	}

	/**
	 * Kill all spawned MCP server processes. Safe to call even if `start()` was
	 * never called or returned early.
	 */
	async stop(): Promise<void> {
		for (const handle of this.servers) {
			this._killTree(handle);
		}
		this.servers = [];
	}

	/**
	 * Kill a server process, including any child processes it spawned.
	 *
	 * On win32, commands like `npx`/`npm`/`pnpm`/`yarn` run as `.cmd`, so the
	 * spawned process is actually `cmd.exe` with the real server as a grandchild.
	 * `ChildProcess#kill()` only signals the immediate child and leaves the
	 * grandchild running — use `taskkill /t` to kill the whole process tree instead.
	 */
	private _killTree(handle: ServerHandle): void {
		const pid = handle.process.pid;
		if (pid === undefined) return;

		if (process.platform === 'win32') {
			try {
				spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {stdio: 'ignore', shell: false});
			} catch {
				// Fall through to a direct kill below
			}
		}

		try {
			handle.process.kill();
		} catch {
			// Already dead — ignore
		}
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private async _startServer(name: string, cfg: McpServerConfig): Promise<LocalTool[]> {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...(cfg.env ?? {}),
		};

		let command = cfg.command;
		if (process.platform === 'win32') {
			if (command === 'npx' || command === 'npm' || command === 'pnpm' || command === 'yarn') {
				command = `${command}.cmd`;
			}
		}

		const proc = spawn(command, cfg.args ?? [], {
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
		});

		const handle: ServerHandle = {
			name,
			process: proc,
			buffer: '',
			pending: new Map(),
		};
		this.servers.push(handle);

		// Wire up stdout → line parser
		proc.stdout.on('data', (chunk: Buffer) => {
			handle.buffer += chunk.toString('utf8');
			this._drainLines(handle);
		});

		// Log stderr for debugging
		proc.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8').trim();
			if (text) {
				console.warn(`[synapse] MCP server "${name}" stderr: ${text}`);
			}
		});

		proc.on('error', (err: Error) => {
			console.error(`[synapse] MCP server "${name}" process error:`, err);
			// Reject all pending requests
			for (const {reject} of handle.pending.values()) {
				reject(err);
			}
			handle.pending.clear();
		});

		proc.on('exit', (code: number | null) => {
			if (code !== null && code !== 0) {
				console.warn(`[synapse] MCP server "${name}" exited with code ${code}`);
			}
			// Reject any remaining pending requests
			const err = new Error(`MCP server "${name}" exited unexpectedly`);
			for (const {reject} of handle.pending.values()) {
				reject(err);
			}
			handle.pending.clear();
		});

		// initialize
		await this._sendRequest(handle, 'initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: {name: 'synapse', version: '1.0'},
		});

		// initialized notification (strict protocol compliance)
		try {
			await this._sendNotification(handle, 'notifications/initialized', {});
		} catch (e) {
			console.warn(`[synapse] MCP server "${name}" failed to send initialized notification:`, e);
		}

		// tools/list
		const listRes = await this._sendRequest(handle, 'tools/list', {});
		const tools: McpTool[] = (listRes.result as {tools?: McpTool[]})?.tools ?? [];

		// Wrap each tool as a LocalTool
		return tools.map((t) => this._wrapTool(handle, t));
	}

	/** Send a JSON-RPC request and return a promise that resolves with the response. */
	private _sendRequest(handle: ServerHandle, method: string, params: unknown, timeoutMs = 15000): Promise<JsonRpcResponse> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			const req: JsonRpcRequest = {jsonrpc: '2.0', id, method, params};

			const timeout = window.setTimeout(() => {
				if (handle.pending.has(id)) {
					handle.pending.delete(id);
					reject(new Error(`MCP request "${method}" (id: ${id}) timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);

			handle.pending.set(id, {
				resolve: (r) => {
					window.clearTimeout(timeout);
					resolve(r);
				},
				reject: (e) => {
					window.clearTimeout(timeout);
					reject(e);
				},
			});

			const line = JSON.stringify(req) + '\n';
			handle.process.stdin.write(line, (err) => {
				if (err) {
					window.clearTimeout(timeout);
					handle.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	/** Send a JSON-RPC notification (no id, no expected response). */
	private _sendNotification(handle: ServerHandle, method: string, params: unknown): Promise<void> {
		return new Promise((resolve, reject) => {
			const req = {jsonrpc: '2.0', method, params};
			const line = JSON.stringify(req) + '\n';
			handle.process.stdin.write(line, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	/** Drain completed newline-delimited JSON lines from the buffer and dispatch responses. */
	private _drainLines(handle: ServerHandle): void {
		let newlineIdx: number;
		while ((newlineIdx = handle.buffer.indexOf('\n')) !== -1) {
			const line = handle.buffer.slice(0, newlineIdx).trim();
			handle.buffer = handle.buffer.slice(newlineIdx + 1);
			if (!line) continue;

			let msg: JsonRpcResponse;
			try {
				msg = JSON.parse(line) as JsonRpcResponse;
			} catch {
				// Not valid JSON — ignore (could be a notification or noise)
				continue;
			}

			const pending = handle.pending.get(msg.id);
			if (pending) {
				handle.pending.delete(msg.id);
				if (msg.error) {
					pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
				} else {
					pending.resolve(msg);
				}
			}
		}
	}

	/** Convert an MCP tool descriptor into a `LocalTool`. */
	private _wrapTool(handle: ServerHandle, mcpTool: McpTool): LocalTool {
		return {
			name: mcpTool.name,
			description: mcpTool.description ?? `MCP tool from server "${handle.name}"`,
			parameters: (mcpTool.inputSchema as Record<string, unknown>) ?? {type: 'object', properties: {}},
			execute: async (args: Record<string, unknown>, _app: App): Promise<string> => {
				try {
					const res = await this._sendRequest(handle, 'tools/call', {
						name: mcpTool.name,
						arguments: args,
					});

					// MCP returns { content: Array<{type, text, ...}> }
					const content = (res.result as {content?: Array<{type?: string; text?: string}>})?.content ?? [];
					const text = content
						.map((item) => {
							if (item.type === 'text' && typeof item.text === 'string') {
								return item.text;
							}
							return JSON.stringify(item);
						})
						.join('\n');
					return text || '(no content returned)';
				} catch (e) {
					return `Error calling MCP tool "${mcpTool.name}": ${e instanceof Error ? e.message : String(e)}`;
				}
			},
		};
	}
}
