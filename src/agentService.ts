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
	const nodeReq = typeof window.require === 'function' ? window.require : undefined;
	const events = nodeReq?.('node:events') as typeof import('node:events') | undefined;
	if (events && typeof events.setMaxListeners === 'function') {
		// Intentionally extracted so the wrapper below can call it via `.apply(this,
		// ...)`, which re-binds `this` to whatever `events.setMaxListeners(...)` is
		// called on — the rule can't verify that manual rebinding.
		// eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above
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

// Scoped, refcounted compatibility shim for Electron desktop environment (issue #103/#116).
//
// Electron's renderer keeps the browser/Chromium `setTimeout`, whose return value is a plain
// number — not a Node `Timeout` with `.unref()`. The Agent SDK's `ProcessTransport.close()`
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs) calls `.unref()` unconditionally on a
// SIGTERM→SIGKILL escalation timer whenever `close()` runs while the CLI subprocess is still
// alive, throwing `TypeError: setTimeout(...).unref is not a function`.
//
// Investigation for #116 established that this branch is NOT reached by ordinary query
// completion: `ProcessTransport.readMessages()` always `await`s `waitForExit()` before its
// generator finishes, so by the time the SDK's own cleanup path calls `transport.close()`
// the process has already exited and the escalation branch is skipped — confirmed empirically
// (several partial-message chat sends produced zero console errors without any shim at all).
//
// The branch IS reached when a query is aborted mid-stream: `AbortController.abort()`
// synchronously fires an internal `abort` listener that calls `transport.close()` directly,
// outside the SDK's own try/catch, while the process is typically still running — hitting the
// crash once immediately (the outer escalation timer) and, on win32, potentially again ~2s
// later (the nested SIGKILL timer scheduled by that same escalation callback). See
// `Session.abort()`, which installs this shim only around that forced-kill window.
//
// Refcounted so overlapping aborts (e.g. two sessions racing to stop) don't restore the
// original `setTimeout` while another abort is still relying on the shim.
let setTimeoutShimRefCount = 0;
let originalSetTimeout: typeof globalThis.setTimeout | null = null;

function installSetTimeoutShim(): void {
	setTimeoutShimRefCount++;
	if (setTimeoutShimRefCount > 1) return;
	try {
		originalSetTimeout = globalThis.setTimeout;
		if (typeof originalSetTimeout !== 'function') return;
		const original = originalSetTimeout;
		globalThis.setTimeout = ((...args: Parameters<typeof original>) => {
			const id: unknown = original(...args);
			if (id === null || (typeof id !== 'number' && typeof id !== 'bigint')) return id;
			// `Object(id)` still coerces to the same numeric id via `valueOf()` for
			// `clearTimeout()` (per the WebIDL `long` conversion both use), so no existing
			// `setTimeout`/`clearTimeout` caller elsewhere in the plugin (or Obsidian
			// itself) is affected while the shim is installed.
			const handle = Object(id) as {unref?: () => unknown; ref?: () => unknown};
			handle.unref = () => handle;
			handle.ref = () => handle;
			return handle;
		}) as typeof original;
	} catch {
		// ignore polyfill errors
	}
}

function uninstallSetTimeoutShim(): void {
	setTimeoutShimRefCount = Math.max(0, setTimeoutShimRefCount - 1);
	if (setTimeoutShimRefCount === 0 && originalSetTimeout) {
		globalThis.setTimeout = originalSetTimeout;
		originalSetTimeout = null;
	}
}

/**
 * Force-restore `globalThis.setTimeout` immediately, regardless of outstanding refcount.
 * Called from `AgentService.stop()` (plugin unload path) so an in-flight abort's shim never
 * outlives the plugin — see the register/unload conventions in CLAUDE.md.
 */
function forceRestoreSetTimeoutShim(): void {
	setTimeoutShimRefCount = 0;
	if (originalSetTimeout) {
		globalThis.setTimeout = originalSetTimeout;
		originalSetTimeout = null;
	}
}

/**
 * Milliseconds the shim must stay installed after an abort to outlive the SDK's own
 * escalation timers: a 2s outer check, plus (on win32, if the process still hasn't exited)
 * a further 5s SIGKILL timer scheduled from inside that same callback. A little headroom is
 * added on top of the 7s worst case.
 */
const ABORT_SHIM_GRACE_MS = 8000;

import type {App} from 'obsidian';
import {query, listSessions, getSessionMessages, deleteSession, renameSession, tool, createSdkMcpServer, startup} from '@anthropic-ai/claude-agent-sdk';
import type {
	Options,
	Query,
	SDKMessage,
	SDKAssistantMessage,
	SDKResultMessage,
	SDKPartialAssistantMessage,
	SDKSessionInfo,
	ListSessionsOptions,
	SessionMessage,
	GetSessionMessagesOptions,
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
	SlashCommand,
	AgentInfo,
	SDKControlGetContextUsageResponse,
} from '@anthropic-ai/claude-agent-sdk';
// zod is a transitive dependency of @anthropic-ai/claude-agent-sdk; declaring it
// directly in package.json is a dependency-manifest change out of scope for this
// lint-only fix. Follow-up: add zod as an explicit devDependency/dependency (#115).
// eslint-disable-next-line import/no-extraneous-dependencies -- see comment above
import {z} from 'zod';
import {resolveDefaultCliPath, getCliVersion, cleanEnv} from './runtimeManager';
import type {ResolvedCliPath, CliPathSource} from './runtimeManager';
import {isLocalBackendConfigured, executeLocalProviderQuery, clearCachedDefaultModel, type LocalHistoryMessage, type LocalToolApprovalHandler} from './providerModels';
import {vaultTools} from './vaultTools';
import {debugTrace} from './debug';

// Lazy-loaded for fs.access check in ensureConnected (same pattern as runtimeManager).
const nodeRequire = typeof window.require === 'function' ? window.require : undefined;

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
	SDKPartialAssistantMessage,
	SDKSessionInfo as SessionMetadata,
	ListSessionsOptions as SessionListFilter,
	SessionMessage,
	GetSessionMessagesOptions as SessionMessagesOptions,
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
	SDKModelInfo,
	SlashCommand,
	AgentInfo,
	SDKControlGetContextUsageResponse,
};

export type SessionConfig = Options & {
	plugins?: SdkPluginConfig[];
	skills?: string[];
};

/**
 * One Anthropic Messages API streaming event carried by `SDKPartialAssistantMessage.event`
 * (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`,
 * `message_delta`, `message_stop`). Derived from the SDK's own field rather than imported
 * from `@anthropic-ai/sdk` directly, so this module stays the only place that reaches into
 * SDK package internals (architecture rule from CLAUDE.md).
 */
export type BetaRawMessageStreamEvent = SDKPartialAssistantMessage['event'];

// Note: Session and SessionEvent are exported as classes/interfaces below.

// Types that no longer have a direct Agent SDK equivalent but are referenced
// by consumers — define compatibility aliases.

/** Model info — minimal shape for UI model picker and capability checks. */
export interface ModelInfo {
	id: string;
	name: string;
	/**
	 * Canonical wire model id this row's `id` resolves to (SDK `ModelInfo.resolvedModel`,
	 * e.g. `'sonnet'` -> `'claude-sonnet-5'`). Only Claude (SDK-sourced) models carry this;
	 * local-provider models never set it. Lets a persisted explicit id be matched back to
	 * the alias row that covers it (see `resolveValidModel` / `resolveModelForAgent`).
	 */
	resolvedModel?: string;
	/** Human-readable capability description from the CLI, when available. */
	description?: string;
	/** SDK `ModelInfo.supportsAdaptiveThinking` — Claude decides when/how much to think. */
	supportsAdaptiveThinking?: boolean;
	/** SDK `ModelInfo.supportsFastMode`. */
	supportsFastMode?: boolean;
	/** SDK `ModelInfo.supportsAutoMode`. */
	supportsAutoMode?: boolean;
	capabilities?: {
		supports?: {vision?: boolean; reasoningEffort?: boolean; tools?: boolean};
		/**
		 * Provider-specific limit bag (e.g. a `vision` entry shaped like
		 * `{max_prompt_images?: number}`, read by synapseView.ts). Untyped on purpose —
		 * no current provider populates it, but the shape must stay open for one that does.
		 */
		limits?: Record<string, unknown>;
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

/**
 * Map SDK ModelInfo to the plugin's ModelInfo shape.
 * Only fields the SDK actually publishes are populated — no vision/tools/context-window
 * claims. The SDK's `ModelInfo` has no vision or tool-support field at all, so those stay
 * absent rather than guessed (consumers already treat absent as "assume supported", e.g.
 * `triggerExecutor.ts`'s `modelInfo?.supportsTools !== false`).
 */
export function mapSdkModel(sdk: SDKModelInfo): ModelInfo {
	const efforts = sdk.supportedEffortLevels ?? [];
	return {
		id: sdkModelId(sdk),
		name: sdk.displayName,
		resolvedModel: sdk.resolvedModel,
		description: sdk.description,
		supportsAdaptiveThinking: sdk.supportsAdaptiveThinking,
		supportsFastMode: sdk.supportsFastMode,
		supportsAutoMode: sdk.supportsAutoMode,
		capabilities: {
			supports: {
				reasoningEffort: sdk.supportsEffort ?? efforts.length > 0,
			},
			...(efforts.length > 0 ? {supportedReasoningEfforts: efforts} : {}),
		},
	};
}

/** Placeholder entry shown before the SDK model list is fetched.
 *  Empty id means "let the CLI pick its default". */
export const FALLBACK_CLAUDE_MODELS: ModelInfo[] = [
	{
		id: '',
		name: 'Default',
		capabilities: {
			supports: {reasoningEffort: true},
		},
	},
];

/**
 * Default turn budget for agentic one-shot helpers (inlineChat).
 * High enough for multi-step tool use (search, read, summarize), low enough
 * to stop a runaway loop in unattended contexts (triggers, Telegram).
 */
export const DEFAULT_AGENTIC_MAX_TURNS = 50;

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

export type VersionInfoCallback = (info: {version: string; path: string}) => void;

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

	let timer: number | null = null;
	let timedOut = false;
	if (options?.timeoutMs && options.timeoutMs > 0) {
		timer = window.setTimeout(() => {
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
			window.clearTimeout(timer);
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
	 *
	 * Does NOT point ANTHROPIC_BASE_URL at a local/OpenAI-compatible provider — the Claude
	 * CLI only speaks the Anthropic Messages API, not the OpenAI-shaped `/v1` surface that
	 * Ollama and other local backends expose. Local models run through the separate
	 * `executeLocalProviderQuery` ReAct loop in providerModels.ts instead. Routing a local
	 * model through the real Agent SDK requires a Messages-API-speaking gateway in front of
	 * it (see .docs/research/2026-09-03-provider-matrix.md §6) — a distinct, not-yet-built
	 * feature, not something this method should approximate.
	 */
	private buildEnv(): Record<string, string | undefined> | undefined {
		const env: Record<string, string | undefined> = {
			...cleanEnv(),
			CLAUDE_AGENT_SDK_CLIENT_APP: 'obsidian-synapse/1.0.0',
		};
		if (this.auth.type === 'apiKey' && this.auth.apiKey) {
			env['ANTHROPIC_API_KEY'] = this.auth.apiKey;
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
				if (this.onVersionInfo) {
					this.onVersionInfo({
						version: v.version,
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
	 * path (with version populated) after the version check completes. Safe
	 * to call from the settings UI to get a stable, consistent snapshot
	 * rather than relying on the fire-and-forget mutation in
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

	/**
	 * Check if a model ID is handled by the local provider backend.
	 *
	 * SDK-known ids are checked FIRST, before the `customModels` membership test, and
	 * `customModels` membership is never sufficient on its own. This is deliberate: `customModels`
	 * is populated from whatever a provider's `/v1/models` catalogue returns (setCustomModels(),
	 * agentService.ts:483), and some providers/aggregators (e.g. an OpenRouter-style
	 * `anthropic/claude-*` id, or a provider that simply echoes real `claude-*` ids) can return
	 * ids that collide with — or otherwise still identify — genuine Claude models. If membership
	 * in `customModels` alone were enough to classify a model as local, any such catalogue would
	 * silently misroute Claude models down the degraded local one-shot loop (no skills, subagents,
	 * sessions, permissions or streaming) with no indication to the user. Checking `sdkModels` and
	 * the `/^claude-/i` guard first ensures an SDK-known/Claude-shaped id can never be classified
	 * local, regardless of what a local catalogue happens to contain.
	 */
	isLocalModel(modelId?: string): boolean {
		if (!modelId) return false;
		if (this.sdkModels.some(m => m.id === modelId)) return false;
		if (/^claude-/i.test(modelId)) return false;
		if (this.customModels.some(m => m.id === modelId)) return true;
		if (this.isLocalBackendAvailable()) return true;
		return false;
	}

	/** Resolve a model ID to a valid model known to the plugin/SDK. */
	resolveValidModel(modelId?: string): string | undefined {
		if (!modelId) return undefined;
		if (this.isLocalModel(modelId)) return modelId;
		const allModels = this.getModels();
		if (allModels.length === 0) return modelId;

		const target = modelId.toLowerCase();
		// Exact match first, including the SDK's `resolvedModel` (the canonical wire id an
		// alias row resolves to) so a persisted explicit id like 'claude-sonnet-5' matches
		// the 'sonnet' alias row deterministically instead of falling through to the
		// substring/keyword heuristics below.
		let match = allModels.find(
			m => m.id.toLowerCase() === target || m.name.toLowerCase() === target || m.resolvedModel?.toLowerCase() === target
		);
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

	/** Read a persisted session's transcript (for cold-load history replay). */
	async getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]> {
		return await getSessionMessages(sessionId, options);
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
					}),
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
					}),
				});

				let sessionId = '';
				const textParts: string[] = [];

				for await (const msg of stream) {
					const sdkMsg = msg;

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
						const assistantMsg = sdkMsg;
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
			const sdkMsg = msg;
			if (sdkMsg.type === 'assistant') {
				const assistantMsg = sdkMsg;
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
	 *
	 * Also force-restores `globalThis.setTimeout` if `Session.abort()`'s scoped shim (#116)
	 * happens to still be installed — e.g. the plugin is unloaded a few seconds after a user
	 * clicked stop, before the shim's own grace-period timer got to it — so the plugin never
	 * leaves the global patched past its own lifecycle.
	 */
	async stop(): Promise<void> {
		this.state = 'disconnected';
		forceRestoreSetTimeoutShim();
	}
}

// ── Session event types ─────────────────────────────────────────

/** A simplified session event that bridges Agent SDK messages to the view's event system. */
export interface SessionEvent {
	type: string;
	data: Record<string, unknown>;
}

// ── Plan/task tracking (TodoWrite / TaskCreate+TaskUpdate) ───────

/** A single sub-task, normalized for the view's task panel, regardless of which planning tool produced it. */
export interface TodoItem {
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	/** Present-tense form used while the task is in progress (e.g. "Running tests"). */
	activeForm?: string;
}

/**
 * Parse a `TodoWrite` tool call's `input` payload into a normalized todo list.
 *
 * `TodoWrite` sends the *entire* plan as one call (`{todos: [{content, status, activeForm?}, ...]}`
 * per the SDK's `TodoWriteInput` type), so each call fully replaces prior state — no
 * accumulation needed. Parsed defensively (field presence/types checked, not schema-validated)
 * since a hand-rolled mirror of the SDK type can still drift across CLI versions. Returns `null`
 * when `input` doesn't look like a `TodoWrite` payload at all (so callers can fall back to
 * generic tool-call rendering); returns an empty array when it's a valid-shaped but empty list.
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

/**
 * `TaskCreate`/`TaskUpdate` are a newer, incremental alternative to `TodoWrite` in the same SDK
 * (`sdk-tools.d.ts`: `TaskCreateInput`, `TaskUpdateInput`) — the installed CLI has been observed
 * to prefer this family over `TodoWrite` for planning. Unlike `TodoWrite`, there is no single
 * call carrying the full plan: `TaskCreate` adds one task per call (id assigned server-side,
 * only available from its *result* text, e.g. "Task #3 created successfully: <subject>") and
 * `TaskUpdate` patches one task's fields (including `status`) by id. Tracking the live plan
 * therefore requires accumulating state across calls — `TaskPlan` is a small ordered map the
 * view keeps per turn and updates via the two parse functions below.
 */
export type TaskPlan = Map<string, TodoItem>;

/** Parse a `TaskCreate` tool call's `input` into the fields available before its id is known. */
export function parseTaskCreateInput(input: unknown): {subject: string; activeForm?: string} | null {
	if (!input || typeof input !== 'object') return null;
	const t = input as {subject?: unknown; activeForm?: unknown};
	if (typeof t.subject !== 'string' || !t.subject) return null;
	return {
		subject: t.subject,
		...(typeof t.activeForm === 'string' && t.activeForm ? {activeForm: t.activeForm} : {}),
	};
}

/**
 * Extract the server-assigned task id from a `TaskCreate` tool result's flattened text content
 * (`tool.execution_complete` data's `result.content`). The CLI's `TaskCreateOutput` is a
 * structured `{task: {id, subject}}` object per the SDK type, but tool results are delivered to
 * the view as plain text (see `convertToSessionEvent()`'s `tool_result` handling) — observed
 * format: `"Task #<id> created successfully: <subject>"`. Returns `null` if the text doesn't
 * match (so callers can skip adding an entry rather than tracking it under a wrong/missing id).
 */
export function parseTaskCreateResultId(resultText: string | undefined): string | null {
	if (!resultText) return null;
	const match = /^Task #(\S+) created/.exec(resultText);
	return match?.[1] ?? null;
}

/** Parse a `TaskUpdate` tool call's `input` into the fields it patches on an existing task. */
export function parseTaskUpdateInput(input: unknown): {taskId: string; status?: TodoItem['status'] | 'deleted'; subject?: string; activeForm?: string} | null {
	if (!input || typeof input !== 'object') return null;
	const t = input as {taskId?: unknown; status?: unknown; subject?: unknown; activeForm?: unknown};
	if (typeof t.taskId !== 'string' || !t.taskId) return null;
	const status = t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' || t.status === 'deleted' ? t.status : undefined;
	return {
		taskId: t.taskId,
		...(status ? {status} : {}),
		...(typeof t.subject === 'string' && t.subject ? {subject: t.subject} : {}),
		...(typeof t.activeForm === 'string' && t.activeForm ? {activeForm: t.activeForm} : {}),
	};
}

/**
 * Resolve the `resume` session id a query() call should use: the session's own captured
 * `sessionId` (set once a prior query in *this* `Session` object has streamed at least one
 * message) takes priority; otherwise falls back to `configResume` — the id a rebuilt
 * `Session` was seeded with via `SessionConfig.resume` (see `synapseView.ts`'s
 * `ensureSession()`/`buildSessionConfig()`), which carries the conversation across a
 * `configDirty` rebuild even though the new `Session` object's own `sessionId` starts empty
 * (issue #104). Returns `undefined` (omit `resume`) when neither is set, e.g. a session that
 * has never sent a message.
 */
export function resolveResumeSessionId(sessionId: string, configResume: string | undefined): string | undefined {
	return sessionId || configResume || undefined;
}

/**
 * Cached, one-turn-stale snapshot of the three `Query` control-request answers a live
 * per-turn `Query` handle can serve (issue #130): context-window usage, the CLI's actual
 * slash-command list, and its actual subagent list. See
 * `.docs/decisions/2026-09-04-persistent-query-cache.md` for why this is capture-and-cache
 * rather than a persistent streaming-input `query()`, and exactly when during a turn the
 * capture is safe to attempt.
 */
export interface QueryMetadataCache {
	contextUsage?: SDKControlGetContextUsageResponse;
	commands?: SlashCommand[];
	agents?: AgentInfo[];
}

/**
 * Attempt to refresh `QueryMetadataCache` from a live `Query` handle.
 *
 * **Timing is load-bearing, not incidental.** Empirical testing for #130 established that
 * these control requests only succeed while the underlying CLI process is still alive —
 * which, for the single-turn `query()` this codebase uses (a fresh process per `send()`,
 * see "Agent SDK model" in `agent-service.md`), means *any* point before the stream's
 * terminal `SDKResultMessage` is delivered to the consumer. Calling this at or after that
 * message (the intuitive "end of turn" moment) always fails — `getContextUsage()` throws
 * `Query closed before response received` because the transport has already closed by the
 * time `result` reaches the `for await` loop. `Session.send()` therefore calls this once per
 * non-partial `assistant` SDKMessage (there can be more than one in a tool-loop turn), each
 * call overwriting the previous — so the cache ends up holding whatever was captured at the
 * *last* `assistant` message of the turn, the closest available approximation of "end of
 * turn while still live".
 *
 * **Degrades safely.** Any rejection (older CLI without control-protocol support, a process
 * that's already exited, etc.) is caught here and swallowed: the *previous* cache (`prev`)
 * is returned unchanged, a debug-level trace is emitted, and nothing is thrown into the
 * turn. A turn must never fail because a metrics call failed.
 */
export async function refreshQueryMetadataCache(
	query: Pick<Query, 'getContextUsage' | 'supportedCommands' | 'supportedAgents'>,
	prev: QueryMetadataCache,
	onDebug?: (message: string) => void,
): Promise<QueryMetadataCache> {
	try {
		const [contextUsage, commands, agents] = await Promise.all([
			query.getContextUsage({detail: 'summary'}),
			query.supportedCommands(),
			query.supportedAgents(),
		]);
		return {contextUsage, commands, agents};
	} catch (e) {
		onDebug?.(`[synapse] query metadata capture failed (cache left unchanged): ${e instanceof Error ? e.message : String(e)}`);
		return prev;
	}
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
	/** The in-flight query's `Query` handle, tracked so `abort()` can try a graceful `interrupt()` first. */
	private currentQuery: Query | null = null;
	/**
	 * Set once `abort()`'s `Query.interrupt()` call resolves for the in-flight `send()`. The CLI
	 * doesn't always end an interrupted turn with a clean, silent abort the way a hard
	 * `AbortController.abort()` does — it can surface the interruption as a thrown "error result"
	 * from the stream (`Claude Code returned an error result`). `send()`'s catch treats that the
	 * same as the `AbortError` case (expected, not a failure to report) whenever this is set.
	 */
	private userInterruptRequested = false;
	/**
	 * Capture-and-cache snapshot of `getContextUsage()`/`supportedCommands()`/`supportedAgents()`
	 * (issue #130) — refreshed from `this.currentQuery` once per non-partial `assistant` message
	 * during `send()`, never touched otherwise. One turn stale by design; see
	 * `refreshQueryMetadataCache()`'s doc comment and
	 * `.docs/decisions/2026-09-04-persistent-query-cache.md`.
	 */
	private queryMetadata: QueryMetadataCache = {};
	private handlers: Map<string, SessionEventHandler[]> = new Map();
	private onEventCallback: ((event: SessionEvent) => void) | null = null;
	/** toolCallId -> toolName, tracked from `tool_use` so `tool_result` can report which tool failed. */
	private pendingToolCalls: Map<string, string> = new Map();
	/**
	 * Whether this session's queries request `SDKPartialAssistantMessage` (`stream_event`)
	 * events. When true, `convertToSessionEvent()` dispatches genuine incremental
	 * `assistant.message_delta`/`assistant.reasoning_delta` from `content_block_delta` events
	 * as they arrive, and suppresses the whole-block redispatch it would otherwise do from the
	 * terminal `assistant` message's content blocks — that message still arrives and is used
	 * for reconciliation only (`assistant.message`, tool_use, usage), never a second text dump.
	 * See specs/agent-service.md "Partial message streaming".
	 */
	private readonly partialMessagesEnabled: boolean;
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
		this.partialMessagesEnabled = config.includePartialMessages === true;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	/**
	 * Last captured context-window usage breakdown (issue #130), or `undefined` before the
	 * first successful capture (no turn has completed yet, or every capture attempt so far
	 * has failed). One turn stale — see `queryMetadata`'s doc comment.
	 */
	get cachedContextUsage(): SDKControlGetContextUsageResponse | undefined {
		return this.queryMetadata.contextUsage;
	}

	/**
	 * Last captured slash-command list from the CLI (issue #130), or `undefined` before the
	 * first successful capture. Callers should fall back to the vault directory scan
	 * (`scanSkills()`) when this is `undefined` — see `chat-view.md`.
	 */
	get cachedSupportedCommands(): SlashCommand[] | undefined {
		return this.queryMetadata.commands;
	}

	/**
	 * Last captured subagent list from the CLI (issue #130), or `undefined` before the first
	 * successful capture. Callers should fall back to the vault directory scan (`scanAgents()`)
	 * when this is `undefined` — see `chat-view.md`.
	 */
	get cachedSupportedAgents(): AgentInfo[] | undefined {
		return this.queryMetadata.agents;
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
	 *
	 * `history` (#135) is likewise only used in the local-model branch — the real Agent SDK
	 * carries continuity itself via `resume`/the persisted session id, so passing it there would
	 * be redundant at best. The caller (`SynapseView`) maps its own `ChatMessage[]` transcript
	 * into the neutral `LocalHistoryMessage[]` shape (`sessionConfig.ts#buildLocalHistory`)
	 * before calling `send()`; this method just threads it through unchanged.
	 *
	 * `app` (#138) is only used in the local-model branch, where it's forwarded to
	 * `executeLocalProviderQuery()` as the `App` instance vault tools (`read_note`, `list_notes`,
	 * `search_notes`) execute against — the real Agent SDK path never needs it, since its own
	 * tools run inside the CLI process. `Session`/`AgentService` hold no `App` reference of their
	 * own (architecture rule: SDK/session plumbing stays UI-agnostic), so `SynapseView` passes it
	 * per call, the same shape as `images`/`history`.
	 */
	async send(options: {prompt: string; additionalDirectories?: string[]; timeoutMs?: number; images?: Array<{mimeType: string; base64: string}>; history?: LocalHistoryMessage[]; app?: App}): Promise<void> {
		this.abortController = new AbortController();
		const controller = this.abortController;
		this.userInterruptRequested = false;

		try {
			await sendAndWaitWithAbort(async (ctrl) => {
				const mergedAdditionalDirectories = Array.from(new Set([
					...(this.config.additionalDirectories ?? []),
					...(options.additionalDirectories ?? []),
				]));
				const resumeSessionId = resolveResumeSessionId(this._sessionId, this.config.resume);
				const queryOpts: Options = {
					...this.config,
					abortController: ctrl,
					...(resumeSessionId ? {resume: resumeSessionId} : {}),
					...(mergedAdditionalDirectories.length > 0 ? {additionalDirectories: mergedAdditionalDirectories} : {}),
				};

				if (queryOpts.model && this.service.isLocalModel(queryOpts.model) && this.service.getProviderConfig()) {
					this.dispatch({type: 'assistant.turn_start', data: {}});
					const sysPrompt = typeof queryOpts.systemPrompt === 'string' ? queryOpts.systemPrompt : undefined;

					// Vault tools for the chat panel's local-model branch (#138) — mirrors
					// triggerExecutor.ts's `supportsTools = modelInfo?.supportsTools !== false`
					// gate: a catalogue that explicitly says "no tools" is honored, but a model
					// with no capability info (most OpenAI-compatible catalogues) defaults to
					// allowed.
					//
					// MCP tools are deliberately NOT offered here, unlike triggerExecutor.ts.
					// Triggers run once per file event, so starting/stopping an McpBridgeSession
					// (spawn a stdio server, negotiate JSON-RPC, tear down) once per trigger is
					// cheap relative to the trigger itself. Chat's local branch runs once per
					// user message in a potentially long back-and-forth conversation — paying
					// that spawn/teardown cost on every single turn would make chat noticeably
					// slower, and there is no session-scoped owner in `Session` to keep an MCP
					// bridge alive across turns without a larger lifecycle change than this
					// issue's gap (no vault-tool access in chat) calls for. MCP tools are also
					// arbitrary and not necessarily read-only, unlike the three built-ins, so the
					// smaller surface is also the more conservative default for an unreviewed
					// increment. Revisit if interactive chat needs MCP tools (separate issue).
					const modelInfo = this.service.getModels().find(m => m.id === queryOpts.model);
					const supportsTools = modelInfo?.supportsTools !== false;
					// No App instance to execute tools against (shouldn't happen from the chat
					// panel, which always supplies one) — fail safe by not offering tools rather
					// than crashing on a missing `app` inside providerModels.ts.
					const localTools = (supportsTools && options.app) ? vaultTools : undefined;

					// Approval gate (#138): reuse the same `canUseTool` this session was built
					// with (`SynapseView.buildSessionConfig()`'s `permissionHandler`, which opens
					// `ToolApprovalModal`) rather than a second approval UI, per the issue's
					// decision comment. `providerModels.ts` must not import view/SDK types, so
					// the adapter — translating its neutral `LocalToolApprovalHandler` shape into
					// an Agent-SDK `CanUseTool` call — lives here, the one file that already
					// imports both.
					const canUseTool = queryOpts.canUseTool;
					const onApproveTool: LocalToolApprovalHandler | undefined = (localTools && canUseTool)
						? async (toolName, input, context) => {
							const result = await canUseTool(toolName, input, {
								signal: ctrl.signal,
								toolUseID: context.toolUseID,
								requestId: context.toolUseID,
								title: `${context.isRemoteEndpoint ? 'Remote' : 'Local'} model wants to use ${toolName}`,
								description: context.isRemoteEndpoint
									? `This sends data to ${context.endpoint} — a remote endpoint outside this machine.`
									: `This runs locally against ${context.endpoint} and stays on this machine.`,
							});
							if (result && result.behavior === 'allow') {
								return {allow: true};
							}
							return {allow: false, message: (result && result.behavior === 'deny') ? result.message : 'Denied by user'};
						}
						: undefined;

					const res = await executeLocalProviderQuery(this.service.getProviderConfig()!, {
						prompt: options.prompt,
						systemPrompt: sysPrompt,
						model: queryOpts.model,
						images: options.images,
						history: options.history,
						...(localTools ? {tools: localTools, app: options.app} : {}),
						...(onApproveTool ? {onApproveTool} : {}),
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
				this.currentQuery = stream;

				try {
					for await (const msg of stream) {
						const sdkMsg = msg;

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

						// Capture-and-cache (issue #130): refresh context usage / supported
						// commands / supported agents while the process is still known to be
						// alive. Must run on a non-terminal message — see
						// `refreshQueryMetadataCache()`'s doc comment for why the terminal
						// `result` message is too late. Non-blocking of turn success: a
						// rejected control request leaves `this.queryMetadata` unchanged.
						if (sdkMsg.type === 'assistant' && this.currentQuery) {
							this.queryMetadata = await refreshQueryMetadataCache(
								this.currentQuery,
								this.queryMetadata,
								(message) => debugTrace(message),
							);
							this.dispatch({type: 'session.metadata', data: {...this.queryMetadata}});
						}
					}
				} finally {
					this.currentQuery = null;
				}

				// Dispatch session.idle when the stream ends
				this.dispatch({type: 'session.idle', data: {}});
			}, {abortController: controller, timeoutMs: options.timeoutMs});
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') {
				// User aborted — this is expected
				return;
			}
			if (this.userInterruptRequested) {
				// The CLI surfaced the graceful interrupt() as a thrown "error result" rather
				// than a clean AbortError — still an expected, user-initiated stop, not a
				// failure to report (see the field comment on userInterruptRequested).
				return;
			}
			this.dispatch({type: 'session.error', data: {error: e instanceof Error ? e.message : String(e)}});
			throw e;
		} finally {
			this.abortController = null;
			this.userInterruptRequested = false;
		}
	}

	/**
	 * Abort the current query.
	 *
	 * Prefers the SDK's graceful `Query.interrupt()` control request, which asks the CLI to
	 * stop the current turn and exit through its own normal completion path — the one path
	 * confirmed (see the comment above `installSetTimeoutShim` in this file, #116) never hits
	 * the SDK's broken `.unref()` teardown, because the SDK always awaits process exit before
	 * considering a query done.
	 *
	 * Falls back to hard-aborting the query's `AbortController` when there is no in-flight
	 * query to interrupt, or when `interrupt()` itself fails (e.g. an older CLI without
	 * control-protocol support, or a CLI that's already gone unresponsive). That path forces
	 * the SDK to kill the subprocess while it may still be running, which *does* hit the
	 * broken teardown — so a temporary, refcounted `setTimeout` shim is installed only for
	 * this call, for long enough to outlive the SDK's own escalation timers, then restored.
	 */
	async abort(): Promise<void> {
		const query = this.currentQuery;
		if (query) {
			try {
				await query.interrupt();
				this.userInterruptRequested = true;
				return;
			} catch {
				// Fall through to the forced abort below.
			}
		}
		if (!this.abortController) return;
		installSetTimeoutShim();
		try {
			this.abortController.abort();
		} finally {
			window.setTimeout(() => uninstallSetTimeoutShim(), ABORT_SHIM_GRACE_MS);
		}
	}

	/**
	 * Disconnect the session (cleanup).
	 */
	async disconnect(): Promise<void> {
		await this.abort();
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
				const assistantMsg = msg;
				// Emit turn_start
				this.dispatch({type: 'assistant.turn_start', data: {}});
				// Emit text content as message events. When partial streaming is on, the
				// real incremental deltas already went out from the 'stream_event' case as
				// they arrived — redispatching the now-complete block here would render the
				// whole turn's text a second time. Skip the block-level delta and fall
				// through to the reconciliation `assistant.message` dispatch below, which is
				// a no-op unless the accumulated streamed text actually differs.
				for (const block of assistantMsg.message.content) {
					if (block.type === 'text') {
						if (!this.partialMessagesEnabled) {
							this.dispatch({
								type: 'assistant.message_delta',
								data: {content: block.text, deltaContent: block.text},
							});
						}
					} else if (block.type === 'thinking') {
						if (!this.partialMessagesEnabled) {
							this.dispatch({
								type: 'assistant.reasoning_delta',
								data: {content: (block as {thinking: string}).thinking, deltaContent: (block as {thinking: string}).thinking},
							});
						}
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
			case 'stream_event': {
				// Genuine incremental streaming (issue #103) — only emitted when the session
				// was created with `includePartialMessages: true` (the interactive chat
				// panel). The complete `assistant` message for this turn still follows; see
				// the 'assistant' case above for why it doesn't redispatch these deltas.
				const partial = msg;
				const streamEvent = partial.event;
				if (streamEvent.type === 'content_block_delta') {
					const delta = streamEvent.delta;
					// ttft_ms only rides the turn's first non-ping stream event — surface it
					// alongside whichever delta happens to carry it rather than adding a
					// dedicated event type for a single optional field.
					const ttft = typeof partial.ttft_ms === 'number' ? {ttftMs: partial.ttft_ms} : {};
					if (delta.type === 'text_delta') {
						this.dispatch({
							type: 'assistant.message_delta',
							data: {content: delta.text, deltaContent: delta.text, ...ttft},
						});
					} else if (delta.type === 'thinking_delta') {
						this.dispatch({
							type: 'assistant.reasoning_delta',
							data: {content: delta.thinking, deltaContent: delta.thinking, ...ttft},
						});
					}
				}
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
				const resultMsg = msg;
				// Surface the run's total dollar cost, once known (issue #88). Anthropic
				// only reports total_cost_usd on this terminal message — after every turn
				// of the run has already completed — so this cannot drive true in-flight
				// auto-cancellation (see specs/agent-service.md "Run cost reporting").
				// Dispatched for both success and error results, since a failed/aborted
				// run can still have accrued cost.
				if (typeof resultMsg.total_cost_usd === 'number') {
					this.dispatch({
						type: 'assistant.run_result',
						data: {totalCostUsd: resultMsg.total_cost_usd, numTurns: resultMsg.num_turns},
					});
				}
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
