/**
 * `BackgroundSession` — a chat session kept running while the user is looking at a
 * different session (audit §4: "Background-session state ownership").
 *
 * Previously `BackgroundSession` was a ~30-field struct (`view/types.ts`) the foreground
 * `SynapseView` filled on `saveCurrentToBackground()` and drained on `restoreFromBackground()`
 * — including a `savedDom: DocumentFragment` that physically moved the live chat-container DOM
 * nodes out of the view and back in, which forced every DOM ref (`streamingBodyEl`,
 * `toolCallsContainer`, `reasoningEl`, `activeToolCalls`, `streamingComponent`, …) to travel
 * with it. Every new piece of view state had to be added to the struct, the save method, and
 * the restore method in lockstep.
 *
 * This class instead owns its own state — messages, the streaming-text/reasoning accumulator,
 * turn metadata, and its own `TaskPlanTracker` — and exposes `attach()`/`detach()` for its
 * `Session` event subscriptions. It owns **no DOM refs at all**. `SessionSidebarController.
 * restoreFromBackground()` reconstructs the chat DOM by re-rendering from this state
 * (`messages`, then, if still streaming, a fresh placeholder populated from `streamingContent`/
 * `streamingReasoning`) rather than resurrecting saved DOM nodes. The one accepted
 * simplification: a tool-call block still `is-live` when the session went to the background is
 * not restorable in full visual detail on return — only its plain-text/reasoning/task-plan
 * effects survive. That is not a new gap: a session that *finishes* in the background has
 * always re-rendered from `messages` on restore and dropped that same per-turn tool-call/
 * metadata DOM, so this makes the still-streaming path consistent with it instead of special
 * casing it with a DOM fragment.
 */
import type {Session, SessionEvents} from '../agentService';
import {TaskPlanTracker} from '../taskPlanTracker';
import type {ChatMessage} from '../types';

/** Same shape as `SynapseView.turnUsage` — see its doc comment there. */
export interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	model?: string;
}

/** Hooks the sidebar supplies so this model can trigger a UI refresh without owning any DOM. */
export interface BackgroundSessionCallbacks {
	/** The hidden session went idle (turn finished) — sidebar should drop the active dot and refresh its session list. */
	onIdle(): void;
	/** The hidden session errored — sidebar should drop the active dot. */
	onError(): void;
}

export interface BackgroundSessionInit {
	sessionId: string;
	session: Session;
	messages: ChatMessage[];
	sessionToolGrants: Set<string>;
	isStreaming: boolean;
	streamingContent: string;
	streamingReasoning: string;
	reasoningComplete: boolean;
	turnStartTime: number;
	turnToolsUsed: string[];
	turnUsage: TurnUsage | null;
}

export class BackgroundSession {
	readonly sessionId: string;
	readonly session: Session;
	messages: ChatMessage[];
	/** In-memory tool-approval grants (#193 round 2) carried alongside `session`. */
	sessionToolGrants: Set<string>;
	isStreaming: boolean;
	streamingContent: string;
	streamingReasoning: string;
	reasoningComplete: boolean;
	turnStartTime: number;
	turnToolsUsed: string[];
	turnUsage: TurnUsage | null;
	/** The single plan-state owner for this hidden session (audit §3) — live, not a snapshot. */
	readonly taskPlanTracker: TaskPlanTracker = new TaskPlanTracker();

	private unsubscribers: (() => void)[] = [];

	constructor(init: BackgroundSessionInit) {
		this.sessionId = init.sessionId;
		this.session = init.session;
		this.messages = init.messages;
		this.sessionToolGrants = init.sessionToolGrants;
		this.isStreaming = init.isStreaming;
		this.streamingContent = init.streamingContent;
		this.streamingReasoning = init.streamingReasoning;
		this.reasoningComplete = init.reasoningComplete;
		this.turnStartTime = init.turnStartTime;
		this.turnToolsUsed = init.turnToolsUsed;
		this.turnUsage = init.turnUsage;
	}

	/**
	 * Start routing this session's events while it's hidden — only called when it was still
	 * streaming at save time. Typed `Session.on()` registrations (same `SessionEvents` map the
	 * foreground `registerSessionEvents()` uses), so an unlisted event stays a compile error.
	 * A no-op if already attached (idempotent — callers don't need to track attach state).
	 */
	attach(callbacks: BackgroundSessionCallbacks): void {
		if (this.unsubscribers.length > 0) return;
		const session = this.session;
		const tracker = this.taskPlanTracker;

		const on = <K extends keyof SessionEvents>(type: K, handler: (data: SessionEvents[K]) => void) => session.on(type, handler);

		this.unsubscribers.push(
			on('assistant.turn_start', () => {
				if (this.turnStartTime === 0) this.turnStartTime = Date.now();
			}),
			on('assistant.reasoning_delta', (data) => {
				this.streamingReasoning += data.deltaContent;
				this.reasoningComplete = false;
			}),
			on('assistant.message_delta', (data) => {
				this.streamingContent += data.deltaContent;
				// No DOM rendering — session is hidden.
			}),
			on('assistant.message', (data) => {
				if (data.content !== this.streamingContent) {
					this.streamingContent = data.content;
				}
			}),
			on('assistant.usage', (data) => {
				// input + output only — `assistant.usage` never carries cache token fields
				// (see `SessionEvents` in session.ts), so `turnUsage`'s cache fields stay at 0
				// rather than implying cache usage is tracked. Same as the foreground path.
				if (!this.turnUsage) {
					this.turnUsage = {inputTokens: data.inputTokens, outputTokens: data.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, model: data.model};
				} else {
					this.turnUsage.inputTokens += data.inputTokens;
					this.turnUsage.outputTokens += data.outputTokens;
					if (data.model) this.turnUsage.model = data.model;
				}
			}),
			on('session.idle', () => {
				if (this.streamingContent || this.streamingReasoning) {
					this.messages.push({
						id: `a-${Date.now()}`,
						role: 'assistant',
						content: this.streamingContent,
						reasoning: this.streamingReasoning || undefined,
						timestamp: Date.now(),
					});
				}
				this.resetTurn();
				callbacks.onIdle();
			}),
			on('session.error', (data) => {
				this.messages.push({
					id: `i-${Date.now()}`,
					role: 'info',
					content: `Error: ${data.error || 'Unknown error'}`,
					timestamp: Date.now(),
				});
				this.resetTurn();
				callbacks.onError();
			}),
			on('tool.execution_start', (data) => {
				const {toolName, toolCallId, input: toolInput} = data;
				this.turnToolsUsed.push(toolName);
				// Same tracker as the foreground path (audit §3, #236) — no DOM manipulation
				// for a hidden session, so `renderTodos` is ignored.
				tracker.onToolStart(toolName, toolCallId, toolInput);
			}),
			on('tool.execution_complete', (data) => {
				const {toolName, toolCallId, result, error: toolError} = data;
				tracker.onToolComplete(toolCallId, toolName, result, toolError);
			}),
		);
	}

	/** Stop routing background events (used when restoring this session to the foreground, or on eviction/delete). */
	detach(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
	}

	private resetTurn(): void {
		this.streamingContent = '';
		this.streamingReasoning = '';
		this.reasoningComplete = false;
		this.turnStartTime = 0;
		this.turnToolsUsed = [];
		this.turnUsage = null;
		this.isStreaming = false;
		this.taskPlanTracker.reset();
	}
}
