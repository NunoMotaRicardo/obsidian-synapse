/**
 * AgentService — single entry-point for all Claude Agent SDK access.
 *
 * Wraps `query()` from `@anthropic-ai/claude-agent-sdk` and exposes
 * high-level chat/inlineChat helpers that the rest of the plugin consumes.
 * All SDK type re-exports come from this module so no other file imports
 * the SDK directly (architecture rule from CLAUDE.md).
 *
 * The Electron compatibility shims it used to own live in `./sdkShims` (statically
 * imported below, so their top-level installation still runs at module load); the
 * permission helpers live in `./permissions`, the `Session` class and its event types
 * in `./session`, and the task-plan parsing/tracking in `./taskPlanTracker` — all
 * re-exported further down, so `../agentService` stays the import surface consumers
 * use (audit §1, issue #236).
 */

import {
	sessionScopePermissions,
	permissionRuleToString,
	extractAllowRuleStrings,
	buildInMemoryPermissionSettings,
	mergeVaultSettingsLayer,
} from './permissions';

import {Notice} from 'obsidian';
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
	PermissionRuleValue,
	OnElicitation,
	ElicitationRequest,
	ElicitationResult,
	EffortLevel,
	ModelInfo as SDKModelInfo,
	SlashCommand,
	AgentInfo,
	SDKControlGetContextUsageResponse,
	Settings,
} from '@anthropic-ai/claude-agent-sdk';
// zod is a transitive dependency of @anthropic-ai/claude-agent-sdk; declaring it
// directly in package.json is a dependency-manifest change out of scope for this
// lint-only fix. Follow-up: add zod as an explicit devDependency/dependency (#115).
// eslint-disable-next-line import/no-extraneous-dependencies -- see comment above
import {z} from 'zod';
import {resolveDefaultCliPath, getCliVersion, cleanEnv} from './runtimeManager';
import type {ResolvedCliPath, CliPathSource} from './runtimeManager';
import {fetchEndpointModels} from './providerModels';
import {debugTrace} from './debug';
import {getSynapseSettingsPath} from './vaultPaths';
import {nodeRequire} from './nodeRequire';
// Static import (matching the now-removed mcpBridge.ts's `_synapse/.mcp.json` read, the closest
// precedent for reading a small vault-local JSON config synchronously) rather than the lazy
// `window.require`-gated pattern used elsewhere in this file for fs/promises — that gate exists
// because those call sites' `await import()` fallback only fires once, off the hot path
// (ensureConnected()); `loadVaultSettings()` below must stay synchronous (it runs on every
// query build) and `window.require` is unavailable outside Electron's renderer (e.g. tests),
// where a static Node import still works.
import * as fs from 'node:fs';

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
	PermissionRuleValue,
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
 * Model family keywords the third matching tier of {@link matchModelTiers} looks for in the
 * (lower-cased) target — in escalation order, cheapest family first.
 */
const MODEL_KEYWORDS = ['haiku', 'sonnet', 'opus', 'flash', 'pro'] as const;

/**
 * The shared three-tier model matcher (audit rec 4 — owned here, one implementation):
 * (1) exact match on `id`, `name` or the SDK's `resolvedModel` (the canonical wire id an alias
 * row resolves to, so a persisted explicit id like 'claude-sonnet-5' matches the 'sonnet' alias
 * row deterministically instead of falling through to the substring/keyword heuristics);
 * (2) substring in either direction between target and `id`;
 * (3) first {@link MODEL_KEYWORDS} the target contains, matched against `id`/`name`.
 * Case-insensitive throughout. Returns the first row that matches, or `undefined` when none
 * does — both consumers keep their own preconditions and fallback semantics around it.
 */
export function matchModelTiers(target: string, models: ModelInfo[]): ModelInfo | undefined {
	const needle = target.toLowerCase();
	// Exact match first, including the SDK's `resolvedModel` (the canonical wire id an
	// alias row resolves to) so a persisted explicit id like 'claude-sonnet-5' matches
	// the 'sonnet' alias row deterministically instead of falling through to the
	// substring/keyword heuristics below.
	let match = models.find(
		m => m.id.toLowerCase() === needle || m.name.toLowerCase() === needle || m.resolvedModel?.toLowerCase() === needle
	);
	if (!match) {
		match = models.find(m => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle) || needle.includes(m.id.toLowerCase()));
	}
	if (!match) {
		for (const key of MODEL_KEYWORDS) {
			if (needle.includes(key)) {
				match = models.find(m => m.id.toLowerCase().includes(key) || m.name.toLowerCase().includes(key));
				if (match) break;
			}
		}
	}
	return match;
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
 * absent rather than guessed (consumers already treat absent as "assume supported").
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
 * to stop a runaway loop in unattended contexts (Telegram, other one-shot runs).
 */
export const DEFAULT_AGENTIC_MAX_TURNS = 50;

/**
 * Plan/task-tracking tool names (issue #264) — `TodoWrite` (legacy, one call carries the whole
 * plan) and the `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` family (incremental task graph).
 * CLI 2.1.268 made these default tools only on Claude 3.x, Opus 4.0-4.7, Sonnet 4.0-4.6 and
 * Haiku 4.5 — on every other model (e.g. Opus 5.x, Sonnet 5) they must be explicitly listed in
 * `tools`/`allowedTools` or the plan panel (`taskPlanTracker.ts`) never receives a tool call to
 * parse. Listed in `allowedTools` rather than `tools` so the rest of the default Claude Code
 * toolset isn't replaced — see specs/agent-service.md "Plan/task tracking".
 */
export const PLAN_TRACKING_TOOLS: string[] = ['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'];

/**
 * Named presets for the recurring shapes of `AgentService#inlineChat()` calls (issue #230,
 * audit rec 5). The editor's call sites were previously kept consistent only by convention
 * comments ("pure text transform → `tools: []` + `maxTurns: 1`"); the convention now lives in
 * this interface — callers name the shape with `profile:` and the preset fills in only the
 * fields the caller left unset (a caller's explicit value always wins — same convention as
 * `routeQueryOptions()`).
 *
 * Profiles carry no behavior of their own beyond these option defaults; anything a caller
 * passes explicitly (`permissionMode`, `canUseTool`, …) keeps winning over the preset.
 */
export type InlineChatProfileName = 'textTransform' | 'readOnly' | 'attended' | 'unattendedBypass';

/** Option defaults one named profile fills in — every field optional, every field skippable. */
export interface InlineChatProfile {
	tools?: Options['tools'];
	maxTurns?: number;
	permissionMode?: Options['permissionMode'];
	allowDangerouslySkipPermissions?: boolean;
}

export const INLINE_CHAT_PROFILES: Record<InlineChatProfileName, InlineChatProfile> = {
	/** Pure text transform — no tools, exactly one model turn. */
	textTransform: {tools: [], maxTurns: 1},
	/** Single read-only tool, small loop (image reading/analysis). */
	readOnly: {tools: ['Read'], maxTurns: 10},
	/**
	 * Default toolset, small loop (e.g. mermaid conversion, which uses the vault's skills).
	 * Intentionally leaves `tools` unset → the SDK's FULL default toolset (including
	 * Write/Edit), gated by `permissionMode: 'default'` approval prompts. "Attended" means
	 * a human initiated this one-shot action and is present to answer those prompts — NOT
	 * that the tools are restricted; of the editor profiles only this one is write-capable.
	 */
	attended: {maxTurns: 10},
	/** Unattended runner that must not stop on an approval prompt (Telegram bot). */
	unattendedBypass: {permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true},
};

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

/**
 * A user-configured local agent endpoint (issue #122) — a Messages-API-speaking backend
 * (Ollama v0.14.0+ natively, or another compatible endpoint) that the CLI is repointed at via
 * `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` for local-model queries — the only way local models
 * run since the OpenAI-compatible provider matrix and its hand-rolled ReAct loop were removed
 * (#220). Independent of `AuthConfig` — this only ever overrides the env for queries
 * `isLocalModel()` already classifies as local; it never affects Claude-model queries.
 */
export interface LocalAgentEndpointConfig {
	/** Base URL of the Messages-API-speaking endpoint, e.g. `http://localhost:11434`. */
	baseUrl: string;
	/**
	 * API key sent as `ANTHROPIC_API_KEY`. Ollama requires the header to be present but ignores
	 * its value, so an empty/unset key falls back to the literal `'ollama'` per Ollama's own docs.
	 */
	apiKey?: string;
}

export type VersionInfoCallback = (info: {version: string; path: string}) => void;

// Permission/settings helpers (issue #193/#194) moved to ./permissions — re-exported so the
// consumer import surface (`../agentService`) stays unchanged (audit §1, issue #236).
export {
	sessionScopePermissions,
	permissionRuleToString,
	extractAllowRuleStrings,
	buildInMemoryPermissionSettings,
	mergeVaultSettingsLayer,
};

// Session wrapper, its event map/helpers, and the task-plan parsing/tracking (audit §1, #236)
// moved to ./session and ./taskPlanTracker — re-exported so `../agentService` stays the
// import surface consumers use. `session.ts` imports `AgentService` type-only (the runtime
// import direction is this file importing `Session` for `createSession()`), so there is no
// circular runtime import.
import {
	Session,
	sendAndWaitWithAbort,
	resolveResumeSessionId,
	computeRunCostDelta,
	refreshQueryMetadataCache,
	autoApproveReadOnlyTools,
} from './session';
import type {SessionEvent} from './session';
import {
	TodoItem,
	TaskPlan,
	parseTodoWritePayload,
	parseTaskCreateInput,
	parseTaskCreateResultId,
	parseTaskUpdateInput,
} from './taskPlanTracker';
export {
	sendAndWaitWithAbort,
	resolveResumeSessionId,
	computeRunCostDelta,
	refreshQueryMetadataCache,
	autoApproveReadOnlyTools,
};
export type {
	SessionEvents,
	SessionEvent,
	QueryMetadataCache,
} from './session';
export {Session};
// Task-plan parsing + tracking (audit §1/§3, #236) moved to ./taskPlanTracker — re-exported so
// `../agentService` stays the import surface consumers use (test/agentService.test.ts, view/*).
export type {
	TodoItem,
	TaskPlan,
};
export {
	parseTodoWritePayload,
	parseTaskCreateInput,
	parseTaskCreateResultId,
	parseTaskUpdateInput,
};

/**
 * Manages Claude Agent SDK interactions and provides high-level methods
 * for chat and inline operations from within Obsidian.
 */
export class AgentService {
	private state: ConnectionState = 'disconnected';
	private readonly auth: AuthConfig;
	private readonly localAgentEndpoint?: LocalAgentEndpointConfig;
	private readonly claudeLocation?: string;
	private readonly onConnectionError: ((error: Error) => void) | undefined;
	private readonly onVersionInfo?: VersionInfoCallback;
	private resolvedCli: ResolvedCliPath | null = null;
	private customModels: ModelInfo[] = [];
	private sdkModels: ModelInfo[] = [];
	private cachedDelegationServer: McpServerConfig | null = null;
	/**
	 * Cached parse of `_synapse/settings.json` (issue #194), keyed by its absolute path and
	 * re-read whenever the file's mtime changes — so an edit takes effect on the very next
	 * query (AC-5) without re-parsing an unchanged file on every turn. `settings: null` means
	 * the last read attempt found a malformed file (distinguished from "not cached yet"/`this.
	 * vaultSettingsCache === null`, and from "file absent", which is never cached at all — see
	 * `loadVaultSettings()`).
	 */
	private vaultSettingsCache: {path: string; mtimeMs: number; settings: Settings | null} | null = null;
	/**
	 * mtime (ms) of `_synapse/settings.json` the last time a malformed-JSON Notice fired for
	 * that path, so a broken file warns once per edit rather than once per turn (AC-4) — a
	 * fresh mtime (the user fixed or re-broke the file) clears the dedup and allows one more
	 * Notice.
	 */
	private malformedSettingsWarnedAt: Map<string, number> = new Map();

	constructor(opts?: {
		auth?: AuthConfig;
		localAgentEndpoint?: LocalAgentEndpointConfig;
		claudeLocation?: string;
		onConnectionError?: (error: Error) => void;
		onVersionInfo?: VersionInfoCallback;
	}) {
		this.auth = opts?.auth ?? {type: 'subscription'};
		this.localAgentEndpoint = opts?.localAgentEndpoint;
		this.claudeLocation = opts?.claudeLocation;
		this.onConnectionError = opts?.onConnectionError;
		this.onVersionInfo = opts?.onVersionInfo;
	}

	/**
	 * Whether a local agent endpoint (issue #122) is configured, i.e. a non-empty base URL was
	 * supplied. When true, `isLocalModel()` queries route through the real Agent SDK/CLI with
	 * `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` repointed at it — the only way local models run
	 * since the hand-rolled local ReAct loop was removed (#220).
	 */
	isLocalAgentEndpointConfigured(): boolean {
		return !!this.localAgentEndpoint?.baseUrl?.trim();
	}

	/**
	 * Build the env block for query() calls.
	 *
	 * - When `modelId` is classified local (`isLocalModel()`) AND a local agent endpoint (issue
	 *   #122) is configured, `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` are repointed at that
	 *   endpoint for this call only. This is a per-call decision, not a global one: a
	 *   Claude-model query in the same session is unaffected.
	 * - Otherwise, for API key auth, sets ANTHROPIC_API_KEY from `auth.apiKey`.
	 * - For subscription auth (and no local override), inherits process env (CLI handles OAuth).
	 */
	private buildEnv(modelId?: string): Record<string, string | undefined> | undefined {
		const env: Record<string, string | undefined> = {
			...cleanEnv(),
			CLAUDE_AGENT_SDK_CLIENT_APP: 'obsidian-synapse/1.0.0',
		};
		if (modelId && this.isLocalModel(modelId) && this.localAgentEndpoint?.baseUrl?.trim()) {
			env['ANTHROPIC_BASE_URL'] = this.localAgentEndpoint.baseUrl.trim();
			env['ANTHROPIC_API_KEY'] = this.localAgentEndpoint.apiKey?.trim() || 'ollama';
			return env;
		}
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

	/**
	 * The resolved CLI's version, if already known — from `ensureConnected()`'s
	 * fire-and-forget check or a prior `getVersionInfo()` call — or `undefined`
	 * if no version check has completed yet. Synchronous and never triggers a
	 * version check itself (issue #264): `Session` reads this once per `result`
	 * message to decide whether `total_cost_usd` is cumulative (CLI >= 2.1.277)
	 * without blocking `send()` on a subprocess spawn every turn. Before the
	 * first check completes (e.g. very early in a session's life) this returns
	 * `undefined`, and callers should treat that the same as "unknown."
	 */
	get cachedCliVersion(): string | undefined {
		return this.resolvedCli?.version;
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

	/**
	 * Check if a model ID is handled by the local agent endpoint (issue #122).
	 *
	 * SDK-known ids are checked FIRST, before the `customModels` membership test, and
	 * `customModels` membership is never sufficient on its own. This is deliberate: `customModels`
	 * is populated from whatever the endpoint's `/v1/models` catalogue returns
	 * (`fetchEndpointModels()` → `setCustomModels()`), and an endpoint (or an aggregator behind
	 * it) can return ids that collide with — or otherwise still identify — genuine Claude models.
	 * If membership in `customModels` alone were enough to classify a model as local, any such
	 * catalogue would silently misroute Claude models away from their real auth. Checking
	 * `sdkModels` and the `/^claude-/i` guard first ensures an SDK-known/Claude-shaped id can
	 * never be classified local, regardless of what an endpoint catalogue happens to contain.
	 *
	 * Post-#220 this classifier has exactly one consumer-facing meaning: when true, the query
	 * routes through the Agent SDK with the endpoint repointed via `buildEnv()` (and the model id
	 * preserved by `routeQueryOptions()`). There is no local ReAct loop to fall back to anymore.
	 * The final fallback returns true for an unknown id when the endpoint is configured (the CLI
	 * surfaces a bad id as a query error) and false otherwise (nothing local exists to serve it).
	 */
	isLocalModel(modelId?: string): boolean {
		if (!modelId) return false;
		if (this.sdkModels.some(m => m.id === modelId)) return false;
		if (/^claude-/i.test(modelId)) return false;
		if (this.customModels.some(m => m.id === modelId)) return true;
		if (this.isLocalAgentEndpointConfigured()) return true;
		return false;
	}

	/** Resolve a model ID to a valid model known to the plugin/SDK. */
	resolveValidModel(modelId?: string): string | undefined {
		if (!modelId) return undefined;
		if (this.isLocalModel(modelId)) return modelId;
		const allModels = this.getModels();
		if (allModels.length === 0) return modelId;

		const target = modelId.toLowerCase();
		return matchModelTiers(target, allModels)?.id;
	}

	/** Invalidate the cached delegation server (call when the local agent endpoint config changes). */
	clearDelegationCache(): void {
		this.cachedDelegationServer = null;
		this.cachedEndpointDefaultModel = null;
	}

	/**
	 * Cached first catalogue entry from `fetchEndpointModels()` — the delegation tools' default
	 * model. Cached because the tools resolve it per tool-use, and a fresh `/v1/models` request
	 * on every tool call would be both slow and pointless: the endpoint's model list doesn't
	 * change mid-conversation in any way a user can't also surface by editing the setting
	 * (which rebuilds `AgentService` and clears this via `clearDelegationCache()`'s path).
	 */
	private cachedEndpointDefaultModel: {baseUrl: string; model: string} | null = null;

	/**
	 * Resolve the default model for the delegation tools: the first entry of the configured
	 * endpoint's `/v1/models` catalogue (`fetchEndpointModels()`), replacing the old
	 * `resolveDefaultModel()` over the removed BYOK provider config (#220). Returns
	 * `undefined` when the catalogue can't be fetched or is empty — the tools then run
	 * without an explicit `model` and the CLI picks its own default (a degraded but
	 * functional fallback, same as before).
	 */
	private async resolveEndpointDefaultModel(): Promise<string | undefined> {
		if (!this.localAgentEndpoint?.baseUrl?.trim()) return undefined;
		const baseUrl = this.localAgentEndpoint.baseUrl.trim();
		if (this.cachedEndpointDefaultModel && this.cachedEndpointDefaultModel.baseUrl === baseUrl) {
			return this.cachedEndpointDefaultModel.model;
		}
		const res = await fetchEndpointModels({baseUrl, apiKey: this.localAgentEndpoint.apiKey});
		if (!res.ok || res.models.length === 0) return undefined;
		this.cachedEndpointDefaultModel = {baseUrl, model: res.models[0]!.id};
		return res.models[0]!.id;
	}

	/** Get or create the in-process dynamic delegation MCP server config. */
	getDelegationMcpServer(): McpServerConfig | undefined {
		if (!this.isLocalAgentEndpointConfigured()) {
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
				try {
					const model = await this.resolveEndpointDefaultModel();
					const text = await this.chat({prompt: args.prompt, systemMessage: args.systemPrompt, ...(model ? {model} : {})});
					return {content: [{type: 'text', text: text || ''}]};
				} catch (e) {
					return {content: [{type: 'text', text: `Local agent execution failed: ${e instanceof Error ? e.message : String(e)}`}], isError: true};
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
				const model = await this.resolveEndpointDefaultModel();
				const settled = await Promise.allSettled(
					args.items.map(async (item, i) => {
						const text = await this.chat({prompt: item, systemMessage: sysPrompt, ...(model ? {model} : {})});
						return `Item ${i + 1}:\n${text || ''}`;
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
		/**
		 * Vault handle for the `_synapse/settings.json` layer (issue #194) — see
		 * `routeQueryOptions()`. Not used for anything else here (no vault tools are offered by
		 * this one-shot helper), so it's fine for a caller to omit it, at the cost of the layer
		 * not applying to that call.
		 */
		app?: App;
		abortController?: AbortController;
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<string | undefined> {
		return sendAndWaitWithAbort(async (controller) => {
			try {
				await this.ensureConnected();

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
						env: this.buildEnv(options.model),
						pathToClaudeCodeExecutable: this.resolvedCli?.path,
						abortController: controller,
					}, options.app),
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
	 *
	 * `app` (#194, mirroring `Session.send()`) is read on the real Agent SDK path
	 * (`createQuery()` -> `routeQueryOptions()`) to derive `_synapse/settings.json`'s vault path
	 * for the vault settings layer. `AgentService` holds no `App` reference of its own
	 * (architecture rule: SDK/session plumbing stays UI-agnostic), so each editor action/edit
	 * modal/search caller passes it per call.
	 *
	 * Tools are only offered here when the caller *also* supplies `canUseTool` — editor actions
	 * are one-shot rather than an ongoing attended conversation, so every tool call this
	 * method makes must go through the same approval path as the chat panel's, never a silent
	 * auto-approve. A caller with `app` but no `canUseTool` gets no tools rather than an
	 * ungated one (fails closed, not "always denied" — the tool is simply never offered, so the
	 * model degrades to the current bare one-shot instead of a broken loop).
	 */
	async inlineChat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		systemPrompt?: Options['systemPrompt'];
		plugins?: SdkPluginConfig[];
		skills?: string[];
		agent?: string;
		/**
		 * Named preset from `INLINE_CHAT_PROFILES` filling in the recurring option shapes
		 * (tools/maxTurns/permission fields) — only where the caller left the field unset;
		 * an explicit caller value always wins (issue #230). Options-bag-only field: never
		 * part of `SessionConfig` or the SDK's `Options`.
		 */
		profile?: InlineChatProfileName;
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
		app?: App;
		onEvent?: (msg: SDKMessage) => void;
		abortController?: AbortController;
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<{content: string | undefined; sessionId: string}> {
		return sendAndWaitWithAbort(async (controller) => {
			try {
				await this.ensureConnected();

				// Profile presets fill in only what the caller left unset — a caller's explicit
				// value always wins (issue #230, same convention as routeQueryOptions()).
				const profileDefaults = options.profile ? INLINE_CHAT_PROFILES[options.profile] : undefined;

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
						// loops). The textTransform profile pins maxTurns to 1 instead.
						maxTurns: options.maxTurns ?? profileDefaults?.maxTurns ?? DEFAULT_AGENTIC_MAX_TURNS,
						permissionMode: options.permissionMode ?? profileDefaults?.permissionMode ?? 'default',
						...(options.allowDangerouslySkipPermissions || profileDefaults?.allowDangerouslySkipPermissions ? {allowDangerouslySkipPermissions: true} : {}),
						tools: options.tools ?? profileDefaults?.tools,
						env: this.buildEnv(options.model),
						pathToClaudeCodeExecutable: this.resolvedCli?.path,
						...(options.mcpServers ? {mcpServers: options.mcpServers} : {}),
						...(options.effort ? {effort: options.effort} : {}),
						...(options.resume ? {resume: options.resume} : {}),
						...(options.cwd ? {cwd: options.cwd} : {}),
						abortController: controller,
					}, options.app),
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
		/** Vault handle for the `_synapse/settings.json` layer (issue #194) — see `routeQueryOptions()`. */
		app?: App;
	}): Query {
		return query({
			prompt: options.prompt,
			options: this.routeQueryOptions({
				...options.queryOptions,
				env: {
					...this.buildEnv(options.queryOptions.model),
					...options.queryOptions.env,
				},
				pathToClaudeCodeExecutable: options.queryOptions.pathToClaudeCodeExecutable ?? this.resolvedCli?.path,
			}, options.app),
		});
	}

	/**
	 * Read and parse `_synapse/settings.json` from the vault, synchronously — desktop-only
	 * plugin, tiny file, and a sync read keeps `routeQueryOptions()` (the single choke point
	 * every real SDK query passes through) synchronous too (issue #194).
	 *
	 * Returns `undefined` when the file is absent (AC-2: the plugin never creates it, and a
	 * vault without one must behave exactly as before, silently) or malformed (AC-4: degrades
	 * gracefully — one `[synapse]` Notice + `debugTrace`, no crash, no repeat Notice per turn).
	 * Cached by mtime (`vaultSettingsCache`) so an edit is picked up on the very next query
	 * (AC-5) without re-parsing an unchanged file on every turn.
	 */
	private loadVaultSettings(app: App): Settings | undefined {
		let path: string;
		try {
			path = getSynapseSettingsPath(app);
		} catch {
			return undefined;
		}

		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(path).mtimeMs;
		} catch {
			// File does not exist (or is unreadable for some other reason) — no layer, no
			// Notice: a vault with no settings.json must behave exactly as today (AC-2).
			return undefined;
		}

		if (this.vaultSettingsCache && this.vaultSettingsCache.path === path && this.vaultSettingsCache.mtimeMs === mtimeMs) {
			return this.vaultSettingsCache.settings ?? undefined;
		}

		try {
			const raw = fs.readFileSync(path, 'utf8');
			const parsed = JSON.parse(raw) as Settings;
			this.vaultSettingsCache = {path, mtimeMs, settings: parsed};
			return parsed;
		} catch (e) {
			this.vaultSettingsCache = {path, mtimeMs, settings: null};
			if (this.malformedSettingsWarnedAt.get(path) !== mtimeMs) {
				this.malformedSettingsWarnedAt.set(path, mtimeMs);
				new Notice('[synapse] _synapse/settings.json is not valid JSON — ignoring it for this query.');
				debugTrace('[synapse] Failed to parse vault settings.json:', e);
			}
			return undefined;
		}
	}

	/**
	 * Route query options. Resolves bound model for named agent if configured, defaults
	 * `settingSources` to `['user', 'project']` (issue #196) unless a caller already set its
	 * own, and layers in the vault's `_synapse/settings.json` (issue #194) beneath whatever
	 * `Options.settings` the caller already built (including any in-memory tool-approval
	 * grants) — see `mergeVaultSettingsLayer()`. `app` is optional because not every caller has
	 * one (`AgentService` holds no `App` reference of its own, per the architecture rule); no
	 * `app` means no `_synapse/settings.json` layer, same as a vault with no such file.
	 */
	private routeQueryOptions(options: Options, app?: App): Options {
		const opts = {...options};
		if (!opts.settingSources) {
			// Deliberately drops the SDK default's 'local' source: that's exactly the
			// `<cwd>/.claude/settings.local.json` leak issue #196 closes (including the stale
			// drive-wide grants #193 used to write there). 'project' is kept so a vault
			// `.claude/settings.json` and any vault `CLAUDE.md` still load; 'user' is kept so
			// the user's global `~/.claude/settings.json` keeps applying as it does today.
			opts.settingSources = ['user', 'project'];
		}
		if (opts.model) {
			if (this.isLocalModel(opts.model)) {
				// Preserve the local model id when routing it through the local agent endpoint
				// (issue #122) so it reaches the endpoint (e.g. Ollama) via ANTHROPIC_BASE_URL as
				// the requested model. Without the endpoint configured, `isLocalModel()`'s final
				// fallback returns false for an unknown id, so this branch isn't reached at all
				// — but a `customModels` id with no endpoint still has no local route to run
				// through (the ReAct loop is gone, #220), so the CLI is left to pick its own
				// default rather than being sent an id no backend serves.
				opts.model = this.isLocalAgentEndpointConfigured() ? opts.model : undefined;
			} else {
				opts.model = this.resolveValidModel(opts.model);
			}
		}
		if (this.isLocalAgentEndpointConfigured()) {
			const delegationServer = this.getDelegationMcpServer();
			if (delegationServer) {
				opts.mcpServers = {
					...opts.mcpServers,
					delegation: delegationServer,
				};
			}
		}
		const vaultSettings = app ? this.loadVaultSettings(app) : undefined;
		if (vaultSettings) {
			opts.settings = mergeVaultSettingsLayer(vaultSettings, opts.settings);
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
	/**
	 * `initialCumulativeCostUsd` seeds the new `Session`'s cost-delta baseline (issue #264
	 * AC-4) — pass the outgoing `Session.cumulativeCostUsd` when rebuilding a session that
	 * already had a conversation (e.g. `ensureSession()`'s `configDirty` rebuild) so the
	 * first result the rebuilt session reports is still a per-run delta, not the whole
	 * conversation's cumulative total. Omit it for a genuinely new session, or when no
	 * cheap baseline is available (e.g. resuming a session cold from disk with no live
	 * `Session` to read a baseline from — see specs/agent-service.md "Run cost reporting").
	 */
	async createSession(config: Options, onEvent?: (event: SessionEvent) => void, initialCumulativeCostUsd?: number): Promise<Session> {
		await this.ensureConnected();
		return new Session(this, config, onEvent, initialCumulativeCostUsd);
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	/**
	 * Stop the service. For the Agent SDK, there is no persistent client
	 * to tear down — queries manage their own subprocess lifecycle.
	 *
	 */
	async stop(): Promise<void> {
		this.state = 'disconnected';
	}
}

