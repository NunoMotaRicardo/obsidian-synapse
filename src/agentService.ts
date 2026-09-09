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
	SDKCompactBoundaryMessage,
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
// Static import (matching the now-removed mcpBridge.ts's `_synapse/.mcp.json` read, the closest
// precedent for reading a small vault-local JSON config synchronously) rather than the lazy
// `window.require`-gated pattern used elsewhere in this file for fs/promises — that gate exists
// because those call sites' `await import()` fallback only fires once, off the hot path
// (ensureConnected()); `loadVaultSettings()` below must stay synchronous (it runs on every
// query build) and `window.require` is unavailable outside Electron's renderer (e.g. tests),
// where a static Node import still works.
import * as fs from 'node:fs';

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
 * `runExecutor.ts`'s `modelInfo?.supportsTools !== false`).
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

/**
 * Rewrite CLI-suggested permission updates so approving a tool call never persists a grant to
 * disk. The CLI's `canUseTool` suggestions carry a `destination` of `'userSettings'`,
 * `'projectSettings'`, `'localSettings'`, `'session'`, or `'cliArg'` — for directory-shaped
 * grants (e.g. an out-of-vault `Read` on an attached folder) it suggests `'localSettings'`,
 * which the SDK writes to `<cwd>/.claude/settings.local.json` inside the vault (issue #193).
 * Every `PermissionUpdate` union variant carries `destination`, so overwriting it via spread is
 * type-safe without a per-variant switch. Forcing `'session'` keeps the approval in effect for
 * the rest of the conversation (no re-prompt loop) without ever touching disk.
 */
export function sessionScopePermissions(suggestions: PermissionUpdate[]): PermissionUpdate[] {
	return suggestions.map(u => ({...u, destination: 'session'}));
}

/**
 * Convert one `PermissionRuleValue` to the CLI's rule-string syntax used in
 * `Settings.permissions.allow` entries: `toolName` alone, or `toolName(ruleContent)` when a
 * rule content (e.g. a path/pattern) is present — matching what the CLI itself writes to
 * `settings.local.json` for the same suggestion (issue #193 round 2).
 */
export function permissionRuleToString(rule: PermissionRuleValue): string {
	return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/**
 * Extract allow-rule strings from a set of CLI-suggested `PermissionUpdate`s, for accumulating
 * into the in-memory grant set `sessionScopePermissions()`'s `'session'` destination can't
 * survive across a query() respawn (issue #193 round 2 — see "In-memory tool-approval grants" in
 * `specs/agent-service.md`).
 *
 * Only `addRules` updates with `behavior: 'allow'` translate into an allow-rule. Every other
 * update type this union carries — `replaceRules`/`removeRules` (there is no faithful way to
 * "replace" or "remove" against a purely additive in-memory accumulator), `setMode`, and
 * `addDirectories`/`removeDirectories` — is skipped rather than guessed at. A `behavior` other
 * than `'allow'` (i.e. `'deny'`/`'ask'`) is also skipped: the CLI does not suggest those for an
 * approved tool call, and this function only ever runs on suggestions attached to an `allow`
 * decision (see `ToolApprovalModal`'s Allow button / `SynapseView`'s auto-allow branch).
 */
export function extractAllowRuleStrings(suggestions: PermissionUpdate[]): string[] {
	const rules: string[] = [];
	for (const u of suggestions) {
		if (u.type === 'addRules' && u.behavior === 'allow') {
			rules.push(...u.rules.map(permissionRuleToString));
		}
	}
	return rules;
}

/**
 * Build the inline `Options.settings` value carrying the conversation's accumulated in-memory
 * tool-approval grants (issue #193 round 2), merged with any pre-existing `settings` a caller
 * already set rather than clobbering it.
 *
 * This is what makes an **ask**-mode approval survive the Agent SDK's per-`send()` respawn: the
 * CLI loads an inline `settings` object into its highest-priority user-controlled "flag
 * settings" layer on every `query()` call, so re-sending the same accumulated `allow` list on
 * every turn re-grants it without ever writing to disk — unlike `destination: 'session'`
 * (`sessionScopePermissions()`), which only covers the *current* CLI process and is lost the
 * moment the next `send()` spawns a fresh one.
 *
 * `existing` merges as an object (its own `permissions.allow` list is unioned with `grants`,
 * every other key preserved); if `existing` is a settings *file path* (the SDK also accepts
 * `settings: string`) it is left untouched and returned as-is — there is no way to fold an
 * in-memory grant list into a file on disk without writing to it, which this feature must never
 * do (issue #193's whole point). No caller in this codebase currently sets a string `settings`
 * path, so this is a defensive fallback, not an exercised path.
 */
export function buildInMemoryPermissionSettings(
	grants: Iterable<string>,
	existing?: Options['settings']
): Options['settings'] {
	const allow = Array.from(new Set(grants));
	if (allow.length === 0) return existing;
	if (typeof existing === 'string') return existing;
	return {
		...existing,
		permissions: {
			...existing?.permissions,
			allow: Array.from(new Set([...(existing?.permissions?.allow ?? []), ...allow])),
		},
	};
}

/**
 * Merge the vault's own settings layer (`_synapse/settings.json`, issue #194) beneath whatever
 * `Options.settings` a call site/session already carries — including, notably, #193's
 * in-memory tool-approval grants (`buildInMemoryPermissionSettings()`'s output, folded into
 * `Session.applyToolGrants()`'s `this.config.settings`).
 *
 * `vaultSettings` is always the base and `existing` is always layered on top: `permissions.allow`
 * /`deny`/`ask` are unioned (nothing from either side is dropped — the vault's own rules survive
 * a later `applyToolGrants()` call, AC-3), while every other top-level key prefers `existing`'s
 * value when both set it, so a caller's/session's explicit settings win on conflict.
 *
 * If `existing` is a settings *file path* rather than an object, it is returned unchanged — same
 * defensive convention as `buildInMemoryPermissionSettings()`'s `existing` handling, and for the
 * same reason: there is no way to fold an object (the parsed vault file) into an arbitrary path
 * on disk without writing to it. No caller in this codebase sets a string `Options.settings`
 * today.
 */
export function mergeVaultSettingsLayer(vaultSettings: Settings, existing?: Options['settings']): Options['settings'] {
	if (typeof existing === 'string') return existing;
	return {
		...vaultSettings,
		...existing,
		permissions: {
			...vaultSettings.permissions,
			...existing?.permissions,
			allow: Array.from(new Set([...(vaultSettings.permissions?.allow ?? []), ...(existing?.permissions?.allow ?? [])])),
			deny: Array.from(new Set([...(vaultSettings.permissions?.deny ?? []), ...(existing?.permissions?.deny ?? [])])),
			ask: Array.from(new Set([...(vaultSettings.permissions?.ask ?? []), ...(existing?.permissions?.ask ?? [])])),
		},
	};
}

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
	 * are one-shot rather than an ongoing attended conversation, so there is no "unattended by
	 * design" precedent (`runExecutor.ts`) to fall back to running ungated; every tool call this
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

/**
 * Typed event map for the session-event seam (`Session.dispatch()` / `Session.on()` /
 * `AgentService.createSession()`'s `onEvent` callback). Keys are the exact string literals
 * `Session.convertToSessionEvent()` and `Session.send()` dispatch; each payload type is derived
 * from what the producer actually sends and what the (sole) consumer(s) actually read — see
 * "Session event map" in `specs/agent-service.md`. Adding a new dispatched event, or a new
 * field a handler reads, means adding it here first: `dispatch`/`on` are generic over this map,
 * so an unlisted event name or a payload that doesn't match is a compile error in both
 * directions (AC-1/AC-2 of #179).
 */
export interface SessionEvents {
	/** First message of a (re)established session delivered its id. */
	'session.init': {sessionId: string};
	/** Capture-and-cache refresh of context usage / supported commands / supported agents (#130). */
	'session.metadata': QueryMetadataCache;
	/** The stream for the current turn ended (success or already-reported error). */
	'session.idle': Record<string, never>;
	'session.error': {error: string};
	'session.compaction_complete': {
		preCompactionTokens?: number;
		postCompactionTokens?: number;
		durationMs?: number;
		trigger?: 'manual' | 'auto';
	};
	/** A new turn started (one per `assistant` SDKMessage, i.e. possibly more than once per send()). */
	'assistant.turn_start': Record<string, never>;
	'assistant.message_delta': {content: string; deltaContent: string; ttftMs?: number};
	'assistant.reasoning_delta': {content: string; deltaContent: string; ttftMs?: number};
	/** Reconciliation dispatch of the turn's full accumulated text. */
	'assistant.message': {content: string};
	'assistant.usage': {inputTokens: number; outputTokens: number; model: string};
	/** Dispatched once per run when the terminal SDKResultMessage reports a dollar cost (#88). */
	'assistant.run_result': {totalCostUsd: number; numTurns: number};
	'tool.execution_start': {toolName: string; toolCallId: string; input: unknown};
	'tool.execution_complete': {
		toolCallId: string;
		toolName?: string;
		success: boolean;
		result: {content: string};
		error?: {message: string};
	};
}

/**
 * Discriminated union of every `{type, data}` pair `SessionEvents` describes — the shape
 * `AgentService.createSession()`'s single, type-erased `onEvent` callback receives (it can't be
 * generic over one event at a time, since it's called for all of them), and the shape buffered
 * by `SynapseView`'s `earlyEventBuffer`/replayed through `handleSessionEvent()`. Handlers
 * registered via `Session.on()` do not see this wrapper — they get `data` alone, typed per event
 * (AC-2).
 */
export type SessionEvent = {[K in keyof SessionEvents]: {type: K; data: SessionEvents[K]}}[keyof SessionEvents];

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

/**
 * Auto-approving `CanUseTool` for `inlineChat()` call sites that request only the read-only
 * tool set — `['Read']` or `['Read', 'Glob', 'Grep']`. Introduced by #167 for `searchPanel.ts`
 * (`maxTurns: 40`) so a search never opens one approval modal per tool call.
 *
 * This is deliberately **not** a new permission concept, and is narrower than #151's
 * `resolveToolApprovalPolicy()` (`src/runExecutor.ts`), which governs unattended runs that may
 * request write-capable tools and therefore must fail closed (`'ask'` == deny with no human to
 * ask). The read-only case is different: a verified spike against the live CLI showed the Agent
 * SDK path *never invokes* `canUseTool` for `Read`/`Glob`/`Grep` at all — it auto-approves them
 * before the callback would even fire — while a write tool (`Write`) still goes through
 * `canUseTool` and is denied with no attended handler present. This handler therefore
 * reproduces the CLI's own shipped behavior for these tools rather than inventing a laxer
 * one. See "Tool approval for inlineChat()'s read-only callers" in `specs/agent-service.md`.
 *
 * The read-only set is **enforced here**, not merely assumed of the caller: any tool outside
 * `READ_ONLY_TOOL_NAMES` is denied. `inlineChat()` forwards the same `canUseTool` to the raw
 * Claude-path `query()` call too, so a blanket always-allow handler would silently grant writes
 * to any future call site that wired it in alongside a write-capable tool. Failing closed on the
 * tool name keeps the guarantee in the code rather than in this comment. Call sites that
 * legitimately need write-capable tools stay on #151's `resolveToolApprovalPolicy()` path.
 */
const READ_ONLY_TOOL_NAMES = new Set([
	// searchPanel's SEARCH_TOOLS and editorMenu's ['Read'].
	'Read', 'Glob', 'Grep',
]);

export const autoApproveReadOnlyTools: CanUseTool = async (toolName, input) => {
	if (READ_ONLY_TOOL_NAMES.has(toolName)) {
		return {behavior: 'allow', updatedInput: input};
	}
	// AskUserQuestion needs an attended UI to answer it (issue #182's AskUserQuestionModal, wired
	// only in synapseView.ts's chat-panel permissionHandler) — this call site (search) runs
	// unattended, so say so explicitly rather than the generic "not read-only" wording.
	if (toolName === 'AskUserQuestion') {
		return {
			behavior: 'deny',
			message: 'Synapse: no one is available to answer AskUserQuestion in this unattended run.',
		};
	}
	return {
		behavior: 'deny',
		message: `Synapse: "${toolName}" is not one of the read-only tools this call site auto-approves.`,
	};
};

// ── Session wrapper ─────────────────────────────────────────────

type SessionEventHandler<K extends keyof SessionEvents = keyof SessionEvents> = (data: SessionEvents[K]) => void;

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
	/**
	 * Stored type-erased: a `Map` keyed by every possible `SessionEvents` key can't itself carry
	 * a different handler-value type per key. Type-safety is enforced at the `on()`/`dispatch()`
	 * boundary instead, where the generic `K` ties a given call's event name to its payload type.
	 */
	private handlers: Map<keyof SessionEvents, SessionEventHandler[]> = new Map();
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
	 * Update this session's live `settings` in place (issue #193 round 2), so an in-memory
	 * tool-approval grant added mid-conversation (via `ToolApprovalModal`'s Allow button)
	 * reaches the *next* `send()` on this same `Session` object without requiring a full
	 * `ensureSession()` rebuild — a permission grant that only took effect after the next
	 * `configDirty` rebuild would still re-prompt for every turn in between. `send()` always
	 * reads `this.config` fresh on each call (`queryOpts: Options = {...this.config, ...}`), so
	 * mutating it here is picked up by the very next turn.
	 *
	 * Takes the grant set rather than a finished `settings` value so the merge happens *here*,
	 * against this session's own `settings` — `config` is private, so a caller could only ever
	 * pass a grants-only object and would silently drop any other `settings` the session was
	 * built with (e.g. #194's `_synapse/settings.json`).
	 */
	applyToolGrants(grants: Iterable<string>): void {
		this.config = {...this.config, settings: buildInMemoryPermissionSettings(grants, this.config.settings)};
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
	 * Register an event handler for one `SessionEvents` key. Returns an unsubscribe function.
	 * Partial registration is correct: a call site (e.g. `registerBackgroundEvents()`) is free to
	 * subscribe to a subset of `SessionEvents` — this is not exhaustiveness-checked, by design.
	 */
	on<K extends keyof SessionEvents>(eventType: K, handler: (data: SessionEvents[K]) => void): () => void {
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
	 * `app` (#138/#194) is read on the real Agent SDK path (`createQuery()` ->
	 * `routeQueryOptions()`) to derive `_synapse/settings.json`'s vault path for the vault
	 * settings layer — the CLI itself doesn't need an `App`, since its own tools run inside
	 * the CLI process, but locating the vault-scoped settings file does.
	 * `Session`/`AgentService` hold no `App` reference of their own (architecture rule:
	 * SDK/session plumbing stays UI-agnostic), so `SynapseView` passes it per call.
	 */
	async send(options: {prompt: string; additionalDirectories?: string[]; timeoutMs?: number; app?: App}): Promise<void> {
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

				const stream = this.service.createQuery({
					prompt: options.prompt,
					queryOptions: queryOpts,
					app: options.app,
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
								this.dispatch('session.init', {sessionId: this._sessionId});
							}
						}

						// Convert SDKMessage to a SessionEvent, dispatching it directly (see
						// convertToSessionEvent()'s doc comment for why it dispatches rather than
						// returns).
						this.convertToSessionEvent(sdkMsg);

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
							this.dispatch('session.metadata', {...this.queryMetadata});
						}
					}
				} finally {
					this.currentQuery = null;
				}

				// Dispatch session.idle when the stream ends
				this.dispatch('session.idle', {});
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
			this.dispatch('session.error', {error: e instanceof Error ? e.message : String(e)});
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

	/**
	 * Dispatch one `SessionEvents` event. Generic over `K` so an unknown event name, or a
	 * `data` payload that doesn't match that event's declared shape, is a build error
	 * (AC-1 of #179) — see `SessionEvents`' doc comment.
	 */
	private dispatch<K extends keyof SessionEvents>(type: K, data: SessionEvents[K]): void {
		// Fire onEvent callback (from buildSessionConfig) — type-erased by design (see
		// `SessionEvent`'s doc comment), so it gets the wrapped {type, data} shape.
		if (this.onEventCallback) {
			this.onEventCallback({type, data} as SessionEvent);
		}
		// Fire typed handlers
		const handlers = this.handlers.get(type);
		if (handlers) {
			for (const h of handlers) h(data);
		}
	}

	/**
	 * Convert an SDKMessage into `SessionEvents` dispatches. Dispatches directly (rather than
	 * returning an event for the caller to dispatch) so every case can use the generic,
	 * per-event-typed `dispatch<K>()` without a caller-side union type that would defeat that
	 * typing — see `SessionEvent`'s doc comment for why the wrapped `{type, data}` shape is kept
	 * only for the type-erased `onEventCallback` path.
	 */
	private convertToSessionEvent(msg: SDKMessage): void {
		switch (msg.type) {
			case 'assistant': {
				const assistantMsg = msg;
				// Emit turn_start
				this.dispatch('assistant.turn_start', {});
				// Emit text content as message events. When partial streaming is on, the
				// real incremental deltas already went out from the 'stream_event' case as
				// they arrived — redispatching the now-complete block here would render the
				// whole turn's text a second time. Skip the block-level delta and fall
				// through to the reconciliation `assistant.message` dispatch below, which is
				// a no-op unless the accumulated streamed text actually differs.
				for (const block of assistantMsg.message.content) {
					if (block.type === 'text') {
						if (!this.partialMessagesEnabled) {
							this.dispatch('assistant.message_delta', {content: block.text, deltaContent: block.text});
						}
					} else if (block.type === 'thinking') {
						if (!this.partialMessagesEnabled) {
							const thinking = (block as {thinking: string}).thinking;
							this.dispatch('assistant.reasoning_delta', {content: thinking, deltaContent: thinking});
						}
					} else if (block.type === 'tool_use') {
						const toolBlock = block as {id: string; name: string; input: unknown};
						this.pendingToolCalls.set(toolBlock.id, toolBlock.name);
						this.dispatch('tool.execution_start', {toolName: toolBlock.name, toolCallId: toolBlock.id, input: toolBlock.input});
					}
				}
				// Emit usage if available
				if (assistantMsg.message.usage) {
					this.dispatch('assistant.usage', {
						inputTokens: assistantMsg.message.usage.input_tokens,
						outputTokens: assistantMsg.message.usage.output_tokens,
						model: assistantMsg.message.model,
					});
				}
				// Dispatch the full message event directly (not returned, to avoid double-dispatch)
				this.dispatch('assistant.message', {
					content: assistantMsg.message.content.filter(b => b.type === 'text').map(b => (b as {text: string}).text).join(''),
				});
				return;
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
						this.dispatch('assistant.message_delta', {content: delta.text, deltaContent: delta.text, ...ttft});
					} else if (delta.type === 'thinking_delta') {
						this.dispatch('assistant.reasoning_delta', {content: delta.thinking, deltaContent: delta.thinking, ...ttft});
					}
				}
				return;
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
						this.dispatch('tool.execution_complete', {
							toolCallId,
							toolName,
							success: !b.is_error,
							result: {content: resultText},
							...(b.is_error ? {error: {message: resultText || 'Tool execution failed'}} : {}),
						});
					}
				}
				return;
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
					this.dispatch('assistant.run_result', {totalCostUsd: resultMsg.total_cost_usd, numTurns: resultMsg.num_turns});
				}
				if (resultMsg.is_error) {
					const raw = (resultMsg as {result?: string}).result;
					const subtype = (resultMsg as {subtype?: string}).subtype;
					const error = (typeof raw === 'string' && raw)
						? raw
						: subtype === 'error_max_turns'
							? 'The agent hit its turn limit before finishing. Try again or narrow the request.'
							: `Query failed${subtype ? ` (${subtype})` : ''}.`;
					this.dispatch('session.error', {error});
				}
				return; // session.idle is dispatched after the loop
			}
			case 'system': {
				const subtype = (msg as {subtype?: string}).subtype;
				if (subtype === 'compact_boundary') {
					const compactMsg = msg as SDKCompactBoundaryMessage;
					const meta = compactMsg.compact_metadata;
					this.dispatch('session.compaction_complete', {
						preCompactionTokens: meta?.pre_tokens,
						postCompactionTokens: meta?.post_tokens,
						durationMs: meta?.duration_ms,
						trigger: meta?.trigger,
					});
				}
				return;
			}
			default:
				return;
		}
	}
}
