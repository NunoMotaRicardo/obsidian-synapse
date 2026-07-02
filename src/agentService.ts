/**
 * AgentService — single entry-point for all Claude Agent SDK access.
 *
 * Wraps `query()` from `@anthropic-ai/claude-agent-sdk` and exposes
 * high-level chat/inlineChat helpers that the rest of the plugin consumes.
 * All SDK type re-exports come from this module so no other file imports
 * the SDK directly (architecture rule from CLAUDE.md).
 */

// Compatibility shim for Electron desktop environment.
// Electron's global AbortSignal does not inherit from Node's internal EventTarget/EventEmitter,
// causing events.setMaxListeners(n, signal) inside the Agent SDK to throw ERR_INVALID_ARG_TYPE.
try {
	const nodeReq = typeof globalThis.require === 'function' ? globalThis.require : undefined;
	const events = nodeReq?.('node:events') as typeof import('node:events') | undefined;
	if (events && typeof events.setMaxListeners === 'function') {
		const origSetMaxListeners = events.setMaxListeners;
		events.setMaxListeners = function(n: number, ...eventTargets: unknown[]) {
			try {
				return origSetMaxListeners.apply(this, [n, ...(eventTargets as unknown as [never])]);
			} catch (e: unknown) {
				if (e && typeof e === 'object' && 'code' in e && (e as {code?: string}).code === 'ERR_INVALID_ARG_TYPE') {
					return;
				}
				throw e;
			}
		};
	}
} catch {
	// ignore polyfill errors
}

import {query, listSessions, deleteSession, renameSession, tool, createSdkMcpServer, startup} from '@anthropic-ai/claude-agent-sdk';
import type {
	Options,
	Query,
	SDKMessage,
	SDKAssistantMessage,
	SDKResultMessage,
	SDKSessionInfo,
	ListSessionsOptions,
	McpServerConfig,
	McpStdioServerConfig,
	McpHttpServerConfig,
	McpSSEServerConfig,
	AgentDefinition,
	CanUseTool,
	PermissionResult,
	PermissionUpdate,
	OnElicitation,
	ElicitationRequest,
	ElicitationResult,
	EffortLevel,
	ModelInfo as SDKModelInfo,
} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import {resolveDefaultCliPath, getCliVersion, cleanEnv} from './runtimeManager';
import type {ResolvedCliPath, CliPathSource} from './runtimeManager';
import {isLocalBackendConfigured, executeLocalProviderQuery, clearCachedDefaultModel} from './providerModels';

// Lazy-loaded for fs.access check in ensureConnected (same pattern as runtimeManager).
const nodeRequire = typeof globalThis.require === 'function' ? globalThis.require : undefined;

/** Local SDK plugin configuration for discovery. */
export interface SdkPluginConfig {
	type: 'local';
	path: string;
	skipMcpDiscovery?: boolean;
}

// Re-export types that consumers need (architecture rule: all SDK types via this module)
export type {
	Query,
	SDKMessage,
	SDKAssistantMessage,
	SDKResultMessage,
	SDKSessionInfo as SessionMetadata,
	ListSessionsOptions as SessionListFilter,
	McpServerConfig as MCPServerConfig,
	McpStdioServerConfig as MCPStdioServerConfig,
	McpHttpServerConfig as MCPHTTPServerConfig,
	McpSSEServerConfig as MCPSSEServerConfig,
	AgentDefinition as CustomAgentConfig,
	CanUseTool as PermissionHandler,
	PermissionResult,
	PermissionUpdate,
	OnElicitation as ElicitationHandler,
	ElicitationRequest as ElicitationContext,
	ElicitationResult,
	EffortLevel as ReasoningEffort,
	ResolvedCliPath,
	CliPathSource,
};

export type SessionConfig = Options & {
	plugins?: SdkPluginConfig[];
	skills?: string[];
};

// Note: Session and SessionEvent are exported as classes/interfaces below.

// Types that no longer have a direct Agent SDK equivalent but are referenced
// by consumers — define compatibility aliases.

/** Model info — minimal shape for UI model picker and capability checks. */
export interface ModelInfo {
	id: string;
	name: string;
	capabilities?: {
		supports?: {vision?: boolean; reasoningEffort?: boolean; tools?: boolean};
		limits?: {max_context_window_tokens?: number};
		supportedReasoningEfforts?: string[];
	};
	isVision?: boolean;
	supportsTools?: boolean;
}

/**
 * Derive the model identifier to pass to the CLI from SDK ModelInfo.
 * `sdk.value` is the model identifier the CLI itself reports and accepts
 * ('default', 'sonnet', 'sonnet[1m]', 'opus', 'claude-fable-5[1m]', …).
 * 'default' maps to '' — empty id means "let the CLI pick its default".
 * (Do NOT derive from displayName: "Sonnet (1M context)" or "Fable" do not
 * round-trip to valid model identifiers.)
 */
function sdkModelId(sdk: SDKModelInfo): string {
	return sdk.value === 'default' ? '' : sdk.value;
}

/** Map SDK ModelInfo to the plugin's ModelInfo shape. */
function mapSdkModel(sdk: SDKModelInfo): ModelInfo {
	const efforts = sdk.supportedEffortLevels ?? [];
	return {
		id: sdkModelId(sdk),
		name: sdk.displayName,
		capabilities: {
			supports: {
				vision: true,
				reasoningEffort: sdk.supportsEffort ?? efforts.length > 0,
				tools: true,
			},
			limits: {max_context_window_tokens: 200000},
			...(efforts.length > 0 ? {supportedReasoningEfforts: efforts} : {}),
		},
		isVision: true,
		supportsTools: true,
	};
}

/** Placeholder entry shown before the SDK model list is fetched.
 *  Empty id means "let the CLI pick its default". */
export const FALLBACK_CLAUDE_MODELS: ModelInfo[] = [
	{
		id: '',
		name: 'Default',
		capabilities: {
			supports: {vision: true, reasoningEffort: true, tools: true},
			limits: {max_context_window_tokens: 200000},
		},
		isVision: true,
		supportsTools: true,
	},
];

/**
 * Default turn budget for agentic one-shot helpers (inlineChat).
 * High enough for multi-step tool use (search, read, summarize), low enough
 * to stop a runaway loop in unattended contexts (triggers, Telegram).
 */
export const DEFAULT_AGENTIC_MAX_TURNS = 50;

/** Reasoning summary — kept as a string union for settings compatibility. */
export type ReasoningSummary = 'none' | 'concise' | 'detailed';

/** Context tier — kept for settings compatibility. */
export type ContextTier = 'default' | 'long_context';

/**
 * Connection state tracked by AgentService.
 * The Agent SDK spawns the CLI per-query, so 'connected' means 'ready to query'.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Auth configuration for the service. */
export interface AuthConfig {
	type: 'subscription' | 'apiKey';
	apiKey?: string;
}

export type VersionInfoCallback = (info: {version: string; protocolVersion?: string; path: string}) => void;

/**
 * Executes a query/stream operation with active cancellation and optional timeout.
 * Wraps execution so that on timeout, error, or cancellation, abortController.abort() is invoked
 * to drop in-flight work and resources immediately, and the error is re-thrown.
 */
export async function sendAndWaitWithAbort<T>(
	fn: (controller: AbortController) => Promise<T>,
	options?: {abortController?: AbortController; signal?: AbortSignal; timeoutMs?: number}
): Promise<T> {
	const controller = options?.abortController ?? new AbortController();

	let onExternalAbort: (() => void) | undefined;
	if (options?.signal) {
		if (options.signal.aborted) {
			controller.abort();
		} else {
			onExternalAbort = () => controller.abort();
			options.signal.addEventListener('abort', onExternalAbort, {once: true});
		}
	}

	let timer: ReturnType<typeof setTimeout> | null = null;
	let timedOut = false;
	if (options?.timeoutMs && options.timeoutMs > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, options.timeoutMs);
	}

	try {
		const result = await fn(controller);
		return result;
	} catch (e) {
		controller.abort();
		if (timedOut) {
			throw new Error(`Request timed out after ${options?.timeoutMs ?? 0}ms`);
		}
		throw e;
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
		if (options?.signal && onExternalAbort) {
			options.signal.removeEventListener('abort', onExternalAbort);
		}
	}
}

/**
 * Manages Claude Agent SDK interactions and provides high-level methods
 * for chat and inline operations from within Obsidian.
 */
export class AgentService {
	private state: ConnectionState = 'disconnected';
	private readonly auth: AuthConfig;
	private readonly providerConfig?: import('./providerModels').ProviderConfigOptions;
	private readonly claudeLocation?: string;
	private readonly onConnectionError: ((error: Error) => void) | undefined;
	private readonly onVersionInfo?: VersionInfoCallback;
	private resolvedCli: ResolvedCliPath | null = null;
	private customModels: ModelInfo[] = [];
	private sdkModels: ModelInfo[] = [];
	private cachedDelegationServer: McpServerConfig | null = null;

	constructor(opts?: {
		auth?: AuthConfig;
		providerConfig?: import('./providerModels').ProviderConfigOptions;
		claudeLocation?: string;
		onConnectionError?: (error: Error) => void;
		onVersionInfo?: VersionInfoCallback;
	}) {
		this.auth = opts?.auth ?? {type: 'subscription'};
		this.providerConfig = opts?.providerConfig;
		this.claudeLocation = opts?.claudeLocation;
		this.onConnectionError = opts?.onConnectionError;
		this.onVersionInfo = opts?.onVersionInfo;
	}

	/**
	 * Build the env block for query() calls.
	 * For API key auth, sets ANTHROPIC_API_KEY in the environment.
	 * For subscription auth, inherits process env (CLI handles OAuth).
	 */
	private buildEnv(forLocalModel = false): Record<string, string | undefined> | undefined {
		const env: Record<string, string | undefined> = {
			...cleanEnv(),
			CLAUDE_AGENT_SDK_CLIENT_APP: 'obsidian-synapse/1.0.0',
		};
		if (this.auth.type === 'apiKey' && this.auth.apiKey) {
			env['ANTHROPIC_API_KEY'] = this.auth.apiKey;
		}
		if (forLocalModel && this.providerConfig && this.providerConfig.baseUrl) {
			const preset = (this.providerConfig.preset || '').toLowerCase();
			let baseUrl = this.providerConfig.baseUrl.trim();
			if (preset === 'ollama') {
				baseUrl = baseUrl.replace(/\/+$/, '');
				if (!baseUrl.endsWith('/v1')) {
					baseUrl = `${baseUrl}/v1`;
				}
			}
			env['ANTHROPIC_BASE_URL'] = baseUrl;
			env['OPENAI_BASE_URL'] = baseUrl;
			const token = this.providerConfig.bearerToken || this.providerConfig.apiKey;
			if (token) {
				env['ANTHROPIC_API_KEY'] = token;
				env['OPENAI_API_KEY'] = token;
			}
		}
		return env;
	}

	/**
	 * Resolve the CLI binary path (using explicit settings override if set,
	 * or walking the runtimeManager resolution chain).
	 */
	async resolveCliPath(): Promise<ResolvedCliPath> {
		if (this.resolvedCli) {
			return this.resolvedCli;
		}
		if (this.claudeLocation && this.claudeLocation.trim().length > 0) {
			const path = this.claudeLocation.trim();
			this.resolvedCli = {path, source: 'settings'};
			return this.resolvedCli;
		}
		this.resolvedCli = await resolveDefaultCliPath();
		return this.resolvedCli;
	}

	/**
	 * Ensure the service is ready. For the Agent SDK this resolves the CLI binary
	 * path, verifies it exists on disk, and kicks off an async version check.
	 */
	async ensureConnected(): Promise<void> {
		if (this.state === 'connected') return;
		this.state = 'connecting';
		try {
			// Validate auth: for API key mode, check that we have a key.
			if (this.auth.type === 'apiKey' && !this.auth.apiKey) {
				throw new Error('Anthropic API key is required. Set it in Settings → Claude.');
			}
			const resolved = await this.resolveCliPath();

			// Verify the binary exists before marking as connected. This ensures
			// that the install-guidance Notice in main.ts fires when no CLI is found,
			// rather than failing silently at first query time.
			const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
			try {
				await fs.access(resolved.path);
			} catch {
				throw new Error(`Claude CLI not found at "${resolved.path}". Install with npm install -g @anthropic-ai/claude-code and restart the plugin.`);
			}

			// Fire-and-forget version check to populate version info and trigger callback
			void getCliVersion(resolved.path).then(v => {
				resolved.version = v.version;
				resolved.protocolVersion = v.protocolVersion;
				if (this.onVersionInfo) {
					this.onVersionInfo({
						version: v.version,
						protocolVersion: v.protocolVersion,
						path: resolved.path,
					});
				}
			}).catch(() => { /* ignore version check errors */ });

			this.state = 'connected';
		} catch (e) {
			this.state = 'error';
			throw e;
		}
	}

	/** Current connection state. */
	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Resolve the CLI path and await its version info. Returns the resolved
	 * path (with version/protocolVersion populated) after the version check
	 * completes. Safe to call from the settings UI to get a stable, consistent
	 * snapshot rather than relying on the fire-and-forget mutation in
	 * ensureConnected().
	 *
	 * Returns undefined in remote-only mode (not used by this plugin currently).
	 */
	async getVersionInfo(): Promise<ResolvedCliPath> {
		const resolved = await this.resolveCliPath();
		// If already populated by a previous ensureConnected() version check, return it.
		if (resolved.version) return resolved;
		// Otherwise run the version check now and populate the shared object.
		const v = await getCliVersion(resolved.path);
		resolved.version = v.version;
		resolved.protocolVersion = v.protocolVersion;
		return resolved;
	}

	setCustomModels(models: ModelInfo[]): void {
		this.customModels = models;
	}

	/** Get available Claude models. */
	getModels(): ModelInfo[] {
		const base = this.sdkModels.length > 0 ? this.sdkModels : FALLBACK_CLAUDE_MODELS;
		if (this.customModels.length > 0) {
			return [...this.customModels, ...base];
		}
		return base;
	}

	/** Fetch available models from the CLI via the Agent SDK. */
	async fetchModels(): Promise<ModelInfo[]> {
		await this.ensureConnected();
		const warm = await startup({
			options: {
				maxTurns: 0,
				permissionMode: 'plan',
				tools: [],
				env: this.buildEnv(),
				pathToClaudeCodeExecutable: this.resolvedCli?.path,
			},
		});
		try {
			const q = warm.query('');
			try {
				const initResult = await q.initializationResult();
				this.sdkModels = initResult.models.map(mapSdkModel);
			} finally {
				q.close();
			}
		} catch {
			warm.close();
		}
		return this.getModels();
	}

	/** Check if local backend is configured and available for dynamic delegation. */
	isLocalBackendAvailable(): boolean {
		return isLocalBackendConfigured(this.providerConfig);
	}

	getProviderConfig(): import('./providerModels').ProviderConfigOptions | undefined {
		return this.providerConfig;
	}

	/** Check if a model ID is handled by the local provider backend. */
	isLocalModel(modelId?: string): boolean {
		if (!modelId) return false;
		if (this.customModels.some(m => m.id === modelId)) return true;
		if (this.isLocalBackendAvailable() && !this.sdkModels.some(m => m.id === modelId)) {
			if (!/^claude-/i.test(modelId)) return true;
		}
		return false;
	}

	/** Resolve a model ID to a valid model known to the plugin/SDK. */
	resolveValidModel(modelId?: string): string | undefined {
		if (!modelId) return undefined;
		if (this.isLocalModel(modelId)) return modelId;
		const allModels = this.getModels();
		if (allModels.length === 0) return modelId;

		const target = modelId.toLowerCase();
		let match = allModels.find(m => m.id.toLowerCase() === target || m.name.toLowerCase() === target);
		if (!match) {
			match = allModels.find(m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target) || target.includes(m.id.toLowerCase()));
		}
		if (!match) {
			for (const key of ['haiku', 'sonnet', 'opus', 'flash', 'pro']) {
				if (target.includes(key)) {
					match = allModels.find(m => m.id.toLowerCase().includes(key) || m.name.toLowerCase().includes(key));
					if (match) break;
				}
			}
		}
		return match ? match.id : undefined;
	}

	/** Invalidate the cached delegation server (call when provider config changes). */
	clearDelegationCache(): void {
		this.cachedDelegationServer = null;
		clearCachedDefaultModel();
	}

	/** Get or create the in-process dynamic delegation MCP server config. */
	getDelegationMcpServer(): McpServerConfig | undefined {
		if (!this.isLocalBackendAvailable()) {
			this.cachedDelegationServer = null;
			return undefined;
		}
		if (this.cachedDelegationServer) {
			return this.cachedDelegationServer;
		}

		const cheapGenerateTool = tool(
			'cheap_generate',
			'Delegate a single prompt or lightweight sub-task to the cheap/local-backed model cascade agent.',
			z.object({
				prompt: z.string().describe('The sub-task prompt to execute'),
				systemPrompt: z.string().optional().describe('Optional instructions for the sub-task'),
			}).shape,
			async (args) => {
				const res = await executeLocalProviderQuery(this.providerConfig!, {
					prompt: args.prompt,
					systemPrompt: args.systemPrompt,
				});
				if (res.ok) {
					return {content: [{type: 'text', text: res.content}]};
				} else {
					return {content: [{type: 'text', text: `Local agent execution failed: ${res.error}`}], isError: true};
				}
			}
		);

		const bulkSummarizeTool = tool(
			'bulk_summarize',
			'Delegate bulk summarization of multiple items/notes to the cheap/local-backed model cascade agent.',
			z.object({
				items: z.array(z.string()).describe('List of texts or items to summarize'),
				instruction: z.string().optional().describe('Specific summarization focus or format'),
			}).shape,
			async (args) => {
				const sysPrompt = args.instruction ? `Summarize concisely according to instruction: ${args.instruction}` : 'Summarize the following text concisely.';
				const settled = await Promise.allSettled(
					args.items.map(async (item, i) => {
						const res = await executeLocalProviderQuery(this.providerConfig!, {
							prompt: item,
							systemPrompt: sysPrompt,
						});
						return res.ok ? `Item ${i + 1}:\n${res.content}` : `Item ${i + 1} failed: ${res.error}`;
					})
				);
				const results = settled.map((r) => r.status === 'fulfilled' ? r.value : `Item failed: ${String(r.reason)}`);
				return {content: [{type: 'text', text: results.join('\n\n---\n\n')}]};
			}
		);

		const server = createSdkMcpServer({
			name: 'delegation',
			tools: [cheapGenerateTool, bulkSummarizeTool],
		});

		this.cachedDelegationServer = server;
		return server;
	}

	// ── Sessions ────────────────────────────────────────────────────

	/** List persisted sessions. */
	async listSessions(filter?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
		return await listSessions(filter);
	}

	/** Delete a session. */
	async deleteSession(sessionId: string): Promise<void> {
		return await deleteSession(sessionId);
	}

	/** Rename a session. */
	async renameSession(sessionId: string, title: string): Promise<void> {
		return await renameSession(sessionId, title);
	}

	// ── Convenience: one-shot chat ──────────────────────────────────

	/**
	 * Send a single prompt and collect the assistant's full response.
	 * Creates a temporary query, streams to completion, and returns
	 * the concatenated assistant text.
	 */
	async chat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		plugins?: SdkPluginConfig[];
		skills?: string[];
		agent?: string;
		canUseTool?: CanUseTool;
		onElicitation?: OnElicitation;
		maxTurns?: number;
		permissionMode?: Options['permissionMode'];
		tools?: Options['tools'];
		abortController?: AbortController;
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<string | undefined> {
		return sendAndWaitWithAbort(async (controller) => {
			try {
				await this.ensureConnected();

				if (options.model && this.isLocalModel(options.model) && this.providerConfig) {
					const res = await executeLocalProviderQuery(this.providerConfig, {
						prompt: options.prompt,
						systemPrompt: options.systemMessage,
						model: options.model,
					});
					if (!res.ok) throw new Error(res.error);
					return res.content || undefined;
				}

				const stream = query({
					prompt: options.prompt,
					options: this.routeQueryOptions({
						model: options.model,
						systemPrompt: options.systemMessage,
						...(options.plugins ? {plugins: options.plugins} : {}),
						...(options.skills ? {skills: options.skills} : {}),
						agent: options.agent,
						canUseTool: options.canUseTool,
						onElicitation: options.onElicitation,
						maxTurns: options.maxTurns ?? 1,
						permissionMode: options.permissionMode ?? 'plan',
						tools: options.tools ?? [],
						env: this.buildEnv(),
						pathToClaudeCodeExecutable: this.resolvedCli?.path,
						abortController: controller,
					} as Options),
				});

				const text = await this.collectText(stream);
				return text || undefined;
			} catch (e) {
				if (this.onConnectionError && e instanceof Error && this.isConnectionError(e)) {
					this.onConnectionError(e);
				}
				throw e;
			}
		}, options);
	}

	/**
	 * Send a prompt and return the response text along with the session ID.
	 * The session persists and can be resumed later.
	 */
	async inlineChat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		systemPrompt?: Options['systemPrompt'];
		plugins?: SdkPluginConfig[];
		skills?: string[];
		agent?: string;
		canUseTool?: CanUseTool;
		onElicitation?: OnElicitation;
		maxTurns?: number;
		permissionMode?: Options['permissionMode'];
		allowDangerouslySkipPermissions?: boolean;
		tools?: Options['tools'];
		mcpServers?: Record<string, McpServerConfig>;
		effort?: EffortLevel;
		resume?: string;
		cwd?: string;
		onEvent?: (msg: SDKMessage) => void;
		abortController?: AbortController;
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<{content: string | undefined; sessionId: string}> {
		return sendAndWaitWithAbort(async (controller) => {
			try {
				await this.ensureConnected();

				if (options.model && this.isLocalModel(options.model) && this.providerConfig) {
					const sysPrompt = options.systemMessage ?? (typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined);
					const res = await executeLocalProviderQuery(this.providerConfig, {
						prompt: options.prompt,
						systemPrompt: sysPrompt,
						model: options.model,
					});
					if (!res.ok) throw new Error(res.error);
					const localSessionId = `local-${Date.now()}`;
					if (options.onEvent && res.content) {
						options.onEvent({
							type: 'assistant',
							session_id: localSessionId,
							message: {
								role: 'assistant',
								content: [{type: 'text', text: res.content}],
							},
						} as unknown as SDKMessage);
					}
					return {content: res.content || undefined, sessionId: localSessionId};
				}

				const stream = query({
					prompt: options.prompt,
					options: this.routeQueryOptions({
						model: options.model,
						systemPrompt: options.systemMessage ?? options.systemPrompt,
						...(options.plugins ? {plugins: options.plugins} : {}),
						...(options.skills ? {skills: options.skills} : {}),
						agent: options.agent,
						canUseTool: options.canUseTool,
						onElicitation: options.onElicitation,
						// Agentic default: enough turns for real tool use (Read/Glob/Grep
						// loops). Callers that want a pure text transform pass maxTurns: 1.
						maxTurns: options.maxTurns ?? DEFAULT_AGENTIC_MAX_TURNS,
						permissionMode: options.permissionMode ?? 'default',
						...(options.allowDangerouslySkipPermissions ? {allowDangerouslySkipPermissions: true} : {}),
						tools: options.tools,
						env: this.buildEnv(),
						pathToClaudeCodeExecutable: this.resolvedCli?.path,
						...(options.mcpServers ? {mcpServers: options.mcpServers} : {}),
						...(options.effort ? {effort: options.effort} : {}),
						...(options.resume ? {resume: options.resume} : {}),
						...(options.cwd ? {cwd: options.cwd} : {}),
						abortController: controller,
					} as Options),
				});

				let sessionId = '';
				const textParts: string[] = [];

				for await (const msg of stream) {
					const sdkMsg = msg as SDKMessage;

					// Capture session ID from any message that has one
					if ('session_id' in sdkMsg && typeof sdkMsg.session_id === 'string') {
						sessionId = sdkMsg.session_id;
					}

					// Forward events to caller
					if (options.onEvent) {
						options.onEvent(sdkMsg);
					}

					// Collect text from assistant messages
					if (sdkMsg.type === 'assistant') {
						const assistantMsg = sdkMsg as SDKAssistantMessage;
						for (const block of assistantMsg.message.content) {
							if (block.type === 'text') {
								textParts.push(block.text);
							}
						}
					}

					// Also collect from result message
					if (sdkMsg.type === 'result' && 'result' in sdkMsg) {
						const resultMsg = sdkMsg as SDKResultMessage;
						if ('result' in resultMsg && typeof resultMsg.result === 'string' && resultMsg.result) {
							// Only use result text if we didn't get assistant text
							if (textParts.length === 0) {
								textParts.push(resultMsg.result);
							}
						}
					}
				}

				const content = textParts.join('') || undefined;
				return {content, sessionId};
			} catch (e) {
				if (this.onConnectionError && e instanceof Error && this.isConnectionError(e)) {
					this.onConnectionError(e);
				}
				throw e;
			}
		}, options);
	}

	/**
	 * Create a raw query stream for full control over message handling.
	 * Used by the chat panel for streaming UI updates.
	 */
	createQuery(options: {
		prompt: string;
		queryOptions: Options;
	}): Query {
		return query({
			prompt: options.prompt,
			options: this.routeQueryOptions({
				...options.queryOptions,
				env: {
					...this.buildEnv(),
					...options.queryOptions.env,
				},
				pathToClaudeCodeExecutable: options.queryOptions.pathToClaudeCodeExecutable ?? this.resolvedCli?.path,
			}),
		});
	}

	/**
	 * Route query options. Resolves bound model for named agent if configured.
	 */
	private routeQueryOptions(options: Options): Options {
		const opts = {...options};
		if (opts.model) {
			opts.model = this.isLocalModel(opts.model) ? undefined : this.resolveValidModel(opts.model);
		}
		if (this.isLocalBackendAvailable()) {
			const delegationServer = this.getDelegationMcpServer();
			if (delegationServer) {
				opts.mcpServers = {
					...opts.mcpServers,
					delegation: delegationServer,
				};
			}
		}
		return opts;
	}

	// ── Error detection ────────────────────────────────────────────

	private isConnectionError(error: Error): boolean {
		const msg = error.message.toLowerCase();
		return /econnrefused|enotfound|etimedout|econnreset|ehostunreach|fetch failed|network|socket hang up/.test(msg);
	}

	// ── Text extraction ────────────────────────────────────────────

	private async collectText(stream: Query): Promise<string> {
		const textParts: string[] = [];

		for await (const msg of stream) {
			const sdkMsg = msg as SDKMessage;
			if (sdkMsg.type === 'assistant') {
				const assistantMsg = sdkMsg as SDKAssistantMessage;
				for (const block of assistantMsg.message.content) {
					if (block.type === 'text') {
						textParts.push(block.text);
					}
				}
			}
			// Fall back to result text
			if (sdkMsg.type === 'result' && 'result' in sdkMsg) {
				const resultMsg = sdkMsg as SDKResultMessage;
				if ('result' in resultMsg && typeof resultMsg.result === 'string' && resultMsg.result && textParts.length === 0) {
					textParts.push(resultMsg.result);
				}
			}
		}

		return textParts.join('');
	}

	// ── Session management ─────────────────────────────────────────

	/**
	 * Create a new session wrapper that provides send/on/disconnect methods
	 * compatible with the chat panel's expectations. Each send() call creates
	 * a new query() under the hood, using resume to continue the conversation.
	 */
	async createSession(config: Options, onEvent?: (event: SessionEvent) => void): Promise<Session> {
		await this.ensureConnected();
		return new Session(this, config, onEvent);
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	/**
	 * Stop the service. For the Agent SDK, there is no persistent client
	 * to tear down — queries manage their own subprocess lifecycle.
	 */
	async stop(): Promise<void> {
		this.state = 'disconnected';
	}
}

// ── Session event types ─────────────────────────────────────────

/** A simplified session event that bridges Agent SDK messages to the view's event system. */
export interface SessionEvent {
	type: string;
	data: Record<string, unknown>;
}

// ── Plan/task tracking (TodoWrite) ───────────────────────────────

/** A single sub-task from a `TodoWrite` tool call, normalized for the view's task panel. */
export interface TodoItem {
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	/** Present-tense form used while the task is in progress (e.g. "Running tests"). */
	activeForm?: string;
}

/**
 * Parse a `TodoWrite` tool call's `input` payload into a normalized todo list.
 *
 * The Claude Code CLI emits `{todos: [{content, status, activeForm?}, ...]}`, but this is
 * parsed defensively (not schema-validated against the SDK) since the exact shape isn't a typed
 * part of the SDK's public surface and could drift across CLI versions. Returns `null` when
 * `input` doesn't look like a `TodoWrite` payload at all (so callers can fall back to generic
 * tool-call rendering); returns an empty array when it's a valid-shaped but empty todo list.
 */
export function parseTodoWritePayload(input: unknown): TodoItem[] | null {
	if (!input || typeof input !== 'object') return null;
	const todos = (input as {todos?: unknown}).todos;
	if (!Array.isArray(todos)) return null;

	const items: TodoItem[] = [];
	for (const raw of todos) {
		if (!raw || typeof raw !== 'object') continue;
		const t = raw as {content?: unknown; status?: unknown; activeForm?: unknown};
		const content = typeof t.content === 'string' ? t.content : '';
		if (!content) continue;
		const status: TodoItem['status'] = t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending';
		items.push({
			content,
			status,
			...(typeof t.activeForm === 'string' && t.activeForm ? {activeForm: t.activeForm} : {}),
		});
	}
	return items;
}

// ── Session wrapper ─────────────────────────────────────────────

type SessionEventHandler = (event: SessionEvent) => void;

/**
 * Session wraps the Agent SDK's query() to provide a stateful session API
 * compatible with the chat panel. It:
 * - Tracks a sessionId from the first query
 * - Converts SDKMessage stream events into typed SessionEvent callbacks
 * - Supports send() to continue the conversation (via resume)
 * - Supports abort() via AbortController
 * - Supports disconnect() to clean up
 */
export class Session {
	private service: AgentService;
	private config: Options;
	private _sessionId = '';
	private abortController: AbortController | null = null;
	private handlers: Map<string, SessionEventHandler[]> = new Map();
	private onEventCallback: ((event: SessionEvent) => void) | null = null;
	/** toolCallId -> toolName, tracked from `tool_use` so `tool_result` can report which tool failed. */
	private pendingToolCalls: Map<string, string> = new Map();
	/** Expose the RPC-like interface (stubbed — Agent SDK handles agent selection via options). */
	readonly rpc = {
		agent: {
			select: async (_opts: {name: string}): Promise<void> => {
				// Agent selection is handled via the `agent` option in query().
				// This is a no-op compatibility stub.
			},
		},
		workingDirectory: {
			set: async (_dir: string): Promise<void> => {
				// Working directory is set via the `cwd` option in query().
			},
		},
	};

	constructor(service: AgentService, config: Options, onEvent?: (event: SessionEvent) => void) {
		this.service = service;
		this.config = config;
		this.onEventCallback = onEvent ?? null;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	/**
	 * Register an event handler. Returns an unsubscribe function.
	 */
	on(eventType: string, handler: SessionEventHandler): () => void {
		const list = this.handlers.get(eventType) ?? [];
		list.push(handler);
		this.handlers.set(eventType, list);
		return () => {
			const idx = list.indexOf(handler);
			if (idx >= 0) list.splice(idx, 1);
		};
	}

	/**
	 * Send a message to the session. Creates a query() call, streaming
	 * events to registered handlers. If a sessionId was captured from
	 * a previous query, resumes that session.
	 *
	 * `additionalDirectories` is merged with `this.config.additionalDirectories` (deduped)
	 * so callers can grant read access to attachment paths that fall outside the session's
	 * `cwd` — e.g. absolute out-of-vault paths or clipboard-blob temp files — for this
	 * specific send() call, on top of whatever the session was already configured with.
	 *
	 * `images` (base64-encoded image attachments) is only used in the local-model branch,
	 * where it's threaded through to `executeLocalProviderQuery()` to build a multimodal
	 * message — local models have no agentic `Read` tool, so they need the actual image
	 * bytes rather than a path inlined into the prompt text.
	 */
	async send(options: {prompt: string; additionalDirectories?: string[]; timeoutMs?: number; images?: Array<{mimeType: string; base64: string}>}): Promise<void> {
		this.abortController = new AbortController();
		const controller = this.abortController;

		try {
			await sendAndWaitWithAbort(async (ctrl) => {
				const mergedAdditionalDirectories = Array.from(new Set([
					...(this.config.additionalDirectories ?? []),
					...(options.additionalDirectories ?? []),
				]));
				const queryOpts: Options = {
					...this.config,
					abortController: ctrl,
					...(this._sessionId ? {resume: this._sessionId} : {}),
					...(mergedAdditionalDirectories.length > 0 ? {additionalDirectories: mergedAdditionalDirectories} : {}),
				};

				if (queryOpts.model && this.service.isLocalModel(queryOpts.model) && this.service.getProviderConfig()) {
					this.dispatch({type: 'assistant.turn_start', data: {}});
					const sysPrompt = typeof queryOpts.systemPrompt === 'string' ? queryOpts.systemPrompt : undefined;
					const res = await executeLocalProviderQuery(this.service.getProviderConfig()!, {
						prompt: options.prompt,
						systemPrompt: sysPrompt,
						model: queryOpts.model,
						images: options.images,
					});
					if (ctrl.signal.aborted) return;
					if (res.ok) {
						this.dispatch({
							type: 'assistant.message_delta',
							data: {content: res.content, deltaContent: res.content},
						});
						this.dispatch({
							type: 'assistant.message',
							data: {content: res.content},
						});
						this.dispatch({type: 'session.idle', data: {}});
					} else {
						this.dispatch({type: 'session.error', data: {error: res.error}});
						throw new Error(res.error);
					}
					return;
				}

				const stream = this.service.createQuery({
					prompt: options.prompt,
					queryOptions: queryOpts,
				});

				for await (const msg of stream) {
					const sdkMsg = msg as SDKMessage;

					// Capture session ID — announce it the first time so the view can
					// name the session and update the sidebar (the id is unknown at
					// Session construction time; it only arrives with the first message).
					if ('session_id' in sdkMsg && typeof sdkMsg.session_id === 'string' && sdkMsg.session_id) {
						const isNew = this._sessionId !== sdkMsg.session_id;
						this._sessionId = sdkMsg.session_id;
						if (isNew) {
							this.dispatch({type: 'session.init', data: {sessionId: this._sessionId}});
						}
					}

					// Convert SDKMessage to SessionEvent and dispatch
					const event = this.convertToSessionEvent(sdkMsg);
					if (event) {
						this.dispatch(event);
					}
				}

				// Dispatch session.idle when the stream ends
				this.dispatch({type: 'session.idle', data: {}});
			}, {abortController: controller, timeoutMs: options.timeoutMs});
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') {
				// User aborted — this is expected
				return;
			}
			this.dispatch({type: 'session.error', data: {error: e instanceof Error ? e.message : String(e)}});
			throw e;
		} finally {
			this.abortController = null;
		}
	}

	/**
	 * Abort the current query.
	 */
	async abort(): Promise<void> {
		this.abortController?.abort();
	}

	/**
	 * Disconnect the session (cleanup).
	 */
	async disconnect(): Promise<void> {
		this.abortController?.abort();
		this.handlers.clear();
		this.onEventCallback = null;
	}

	private dispatch(event: SessionEvent): void {
		// Fire onEvent callback (from buildSessionConfig)
		if (this.onEventCallback) {
			this.onEventCallback(event);
		}
		// Fire typed handlers
		const handlers = this.handlers.get(event.type);
		if (handlers) {
			for (const h of handlers) h(event);
		}
	}

	/**
	 * Convert an SDKMessage into a SessionEvent compatible with the view's
	 * event system. Returns null for messages that don't map to events.
	 */
	private convertToSessionEvent(msg: SDKMessage): SessionEvent | null {
		switch (msg.type) {
			case 'assistant': {
				const assistantMsg = msg as SDKAssistantMessage;
				// Emit turn_start
				this.dispatch({type: 'assistant.turn_start', data: {}});
				// Emit text content as message events
				for (const block of assistantMsg.message.content) {
					if (block.type === 'text') {
						this.dispatch({
							type: 'assistant.message_delta',
							data: {content: block.text, deltaContent: block.text},
						});
					} else if (block.type === 'thinking') {
						this.dispatch({
							type: 'assistant.reasoning_delta',
							data: {content: (block as {thinking: string}).thinking, deltaContent: (block as {thinking: string}).thinking},
						});
					} else if (block.type === 'tool_use') {
						const toolBlock = block as {id: string; name: string; input: unknown};
						this.pendingToolCalls.set(toolBlock.id, toolBlock.name);
						this.dispatch({
							type: 'tool.execution_start',
							data: {toolName: toolBlock.name, toolCallId: toolBlock.id, input: toolBlock.input},
						});
					}
				}
				// Emit usage if available
				if (assistantMsg.message.usage) {
					this.dispatch({
						type: 'assistant.usage',
						data: {
							inputTokens: assistantMsg.message.usage.input_tokens,
							outputTokens: assistantMsg.message.usage.output_tokens,
							model: assistantMsg.message.model,
						},
					});
				}
				// Dispatch the full message event directly (not returned, to avoid double-dispatch)
				this.dispatch({
					type: 'assistant.message',
					data: {content: assistantMsg.message.content.filter(b => b.type === 'text').map(b => (b as {text: string}).text).join('')},
				});
				return null;
			}
			case 'user': {
				// Tool results arrive as `tool_result` content blocks on `user` messages.
				// Emit `tool.execution_complete` for each, matched back to the tool name
				// tracked from the corresponding `tool_use` block.
				const userMsg = msg as {message?: {content?: unknown}};
				const content = userMsg.message?.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						const b = block as {type?: string; tool_use_id?: string; content?: string | Array<{type?: string; text?: string}>; is_error?: boolean};
						if (b.type !== 'tool_result' || !b.tool_use_id) continue;
						const toolCallId = b.tool_use_id;
						const toolName = this.pendingToolCalls.get(toolCallId);
						this.pendingToolCalls.delete(toolCallId);
						const resultText = typeof b.content === 'string'
							? b.content
							: Array.isArray(b.content)
								? b.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
								: '';
						this.dispatch({
							type: 'tool.execution_complete',
							data: {
								toolCallId,
								toolName,
								success: !b.is_error,
								result: {content: resultText},
								...(b.is_error ? {error: {message: resultText || 'Tool execution failed'}} : {}),
							},
						});
					}
				}
				return null;
			}
			case 'result': {
				const resultMsg = msg as SDKResultMessage;
				if (resultMsg.is_error) {
					const raw = (resultMsg as {result?: string}).result;
					const subtype = (resultMsg as {subtype?: string}).subtype;
					const error = (typeof raw === 'string' && raw)
						? raw
						: subtype === 'error_max_turns'
							? 'The agent hit its turn limit before finishing. Try again or narrow the request.'
							: `Query failed${subtype ? ` (${subtype})` : ''}.`;
					return {type: 'session.error', data: {error}};
				}
				return null; // session.idle is dispatched after the loop
			}
			case 'system': {
				const subtype = (msg as {subtype?: string}).subtype;
				if (subtype === 'compact_boundary') {
					return {type: 'session.compaction_complete', data: {}};
				}
				return null;
			}
			default:
				return null;
		}
	}
}
