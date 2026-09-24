/**
 * Session — the stateful session wrapper over the Agent SDK's per-turn `query()`
 * (extracted from `agentService.ts` — audit §1, issue #236).
 *
 * Part of the single SDK service surface documented in `specs/agent-service.md`. SDK types are
 * imported as `import type` only (erased at runtime); `AgentService` is imported as a type as
 * well — `session.ts` only calls methods on the instance, and a runtime import here would be
 * circular (`agentService.ts` imports `Session` for `createSession()`; that direction is the
 * runtime import and stays).
 */

import type {
	Options,
	Query,
	SDKMessage,
	SDKCompactBoundaryMessage,
	SDKControlGetContextUsageResponse,
	CanUseTool,
	SlashCommand,
	AgentInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type {App} from 'obsidian';
import type {AgentService} from './agentService';
import {debugTrace} from './debug';
import {abortWithSetTimeoutShim} from './sdkShims';
import {buildInMemoryPermissionSettings} from './permissions';
import {isCliVersionAtLeast} from './runtimeManager';

/**
 * The CLI version (issue #264 AC-3) at and above which a resumed/forked session's
 * `total_cost_usd` on the terminal `result` message became cumulative (the whole
 * conversation's cost) instead of per-run — see `computeRunCostDelta()`.
 */
const CUMULATIVE_COST_CLI_VERSION = '2.1.277';

/**
 * Executes a query/stream operation with active cancellation and optional timeout.
 * Wraps execution so that on timeout, error, or cancellation, the controller is aborted through
 * the Electron-compatible SDK teardown shim before the error is re-thrown.
 */
export async function sendAndWaitWithAbort<T>(
	fn: (controller: AbortController) => Promise<T>,
	options?: {abortController?: AbortController; signal?: AbortSignal; timeoutMs?: number}
): Promise<T> {
	const controller = options?.abortController ?? new AbortController();

	let onExternalAbort: (() => void) | undefined;
	if (options?.signal) {
		if (options.signal.aborted) {
			abortWithSetTimeoutShim(controller);
		} else {
			onExternalAbort = () => abortWithSetTimeoutShim(controller);
			options.signal.addEventListener('abort', onExternalAbort, {once: true});
		}
	}

	let timer: number | null = null;
	let timedOut = false;
	if (options?.timeoutMs && options.timeoutMs > 0) {
		timer = window.setTimeout(() => {
			timedOut = true;
			abortWithSetTimeoutShim(controller);
		}, options.timeoutMs);
	}

	try {
		const result = await fn(controller);
		return result;
	} catch (e) {
		abortWithSetTimeoutShim(controller);
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
 * Turn an SDK `result` message's `total_cost_usd` into this run's own cost (issue #264
 * AC-3), given `prevCumulativeUsd` — the last `total_cost_usd` this `Session` has seen (or
 * was seeded with on a `configDirty` rebuild, `undefined` if none) — and `cliVersion`, the
 * resolved CLI's version string if already known (`AgentService.cachedCliVersion`).
 *
 * CLI >= 2.1.277 reports `total_cost_usd` as the whole resumed/forked session's cumulative
 * total rather than this run's own cost. Since `Session.send()` spawns a fresh CLI process
 * per call (seeded with `resume`), every result would otherwise report the whole
 * conversation's cost once it's past a budget threshold. A CLI older than 2.1.277 reports a
 * genuine per-run value on every call instead — passed through unchanged.
 *
 * There's no version-agnostic first run: `prevCumulativeUsd === undefined` always returns
 * `total` as-is regardless of CLI version, since there's nothing yet to diff against either
 * way. Otherwise the CLI version decides the behavior directly — no heuristic based on
 * whether `total` looks bigger or smaller than the previous run, which used to misread an
 * old CLI's next run as cumulative whenever it happened to cost more than or equal to the
 * previous run (e.g. run 1 costs $0.10, run 2 costs $0.15 — the old heuristic reported
 * $0.05 instead of $0.15). `isCliVersionAtLeast()`'s `undefined` result (version not yet
 * known, or unparseable) is the one case that still falls back to that same heuristic,
 * since there's no better signal available at all in that case.
 */
export function computeRunCostDelta(total: number, prevCumulativeUsd: number | undefined, cliVersion: string | undefined): number {
	if (prevCumulativeUsd === undefined) return total;
	const isCumulative = isCliVersionAtLeast(cliVersion, CUMULATIVE_COST_CLI_VERSION);
	if (isCumulative === true) return Math.max(0, total - prevCumulativeUsd);
	if (isCumulative === false) return total;
	// Unknown/unparseable CLI version — fall back to the pre-version-gate heuristic.
	return total >= prevCumulativeUsd ? total - prevCumulativeUsd : total;
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
 * This is deliberately **not** a new permission concept. The read-only case is different
 * from a write-capable unattended run: a verified spike against the live CLI showed the Agent
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
 * tool name keeps the guarantee in the code rather than in this comment.
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
	/**
	 * Last-seen `total_cost_usd` from a `result` message, used to turn a cumulative total
	 * (CLI >= 2.1.277, on a resumed/forked session) into a per-run delta — see
	 * `convertToSessionEvent()`'s `'result'` case and specs/agent-service.md "Run cost
	 * reporting". `undefined` until the first `result` this `Session` instance has seen,
	 * unless seeded via the constructor's `initialCumulativeCostUsd` (issue #264 AC-4).
	 */
	private lastCumulativeCostUsd: number | undefined;

	constructor(service: AgentService, config: Options, onEvent?: (event: SessionEvent) => void, initialCumulativeCostUsd?: number) {
		this.service = service;
		this.config = config;
		this.onEventCallback = onEvent ?? null;
		this.partialMessagesEnabled = config.includePartialMessages === true;
		this.lastCumulativeCostUsd = initialCumulativeCostUsd;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	/**
	 * This session's last-seen `total_cost_usd` (raw, not a delta) — read by
	 * `ensureSession()`/`SynapseView` before tearing down a `Session` on a `configDirty`
	 * rebuild, and passed as the rebuilt `Session`'s `initialCumulativeCostUsd` seed so the
	 * first run reported after the rebuild is still a per-run delta rather than the whole
	 * conversation's cumulative total (issue #264 AC-4). `undefined` if no `result` has
	 * arrived yet.
	 */
	get cumulativeCostUsd(): number | undefined {
		return this.lastCumulativeCostUsd;
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
	 * Partial registration is correct: a call site (e.g. `BackgroundSession.attach()`) is free to
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
	 * confirmed (see the comment above `installSetTimeoutShim` in `sdkShims.ts`, #116) never hits
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
		abortWithSetTimeoutShim(this.abortController);
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
					const total = resultMsg.total_cost_usd;
					// See computeRunCostDelta()'s doc comment for the version-gated
					// cumulative-vs-per-run logic (issue #264 AC-3). `service.cachedCliVersion`
					// is a synchronous read of whatever ensureConnected()'s version check has
					// already resolved — never a blocking version check on the send() path.
					// `lastCumulativeCostUsd` is always advanced to `total` afterward so the
					// next result diffs against the right baseline.
					const runCostUsd = computeRunCostDelta(total, this.lastCumulativeCostUsd, this.service.cachedCliVersion);
					this.lastCumulativeCostUsd = total;
					this.dispatch('assistant.run_result', {totalCostUsd: runCostUsd, numTurns: resultMsg.num_turns});
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