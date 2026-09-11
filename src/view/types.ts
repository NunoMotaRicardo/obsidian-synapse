import type {App, Component} from 'obsidian';
import type SynapsePlugin from '../main';
import type {SynapseView} from '../synapseView';
import type {Session, TodoItem} from '../agentService';
import type {ChatMessage} from '../types';

/**
 * Narrow bridge a `src/view/*` controller receives instead of the whole `SynapseView`.
 *
 * Composition refactor (per `.docs/research/2026-09-11-view-composition-refactor.md`):
 * each view module becomes a single controller class owning its feature state; it
 * reaches the shared view state through this interface, widened only as conversions
 * prove the need. `SynapseView` implements it.
 */
export interface ViewContext {
	readonly app: App;
	readonly plugin: SynapsePlugin;
	readonly chatContainer: HTMLElement;
	/** The owning view — typed as the full `SynapseView` for shared state still owned there. */
	readonly view: SynapseView;
	/** True while a chat run is streaming (view-owned streaming state). */
	isStreaming: boolean;
	/** Absolute on-disk vault root (delegates to `getVaultBasePath(this.app)`). */
	getVaultBasePath(): string;
	/** Session's working directory (chat panel). */
	getWorkingDirectory(): string;
	/** Whether the session config is dirty and `ensureSession()` must rebuild before the next send. */
	configDirty: boolean;
}

/** State for a session that may be running in the background while the user views another session. */
export interface BackgroundSession {
	sessionId: string;
	session: Session;
	messages: ChatMessage[];
	/** In-memory tool-approval grants (#193 round 2) carried alongside `session` — see `SynapseView.sessionToolGrants`. */
	sessionToolGrants: Set<string>;
	isStreaming: boolean;
	streamingContent: string;
	streamingReasoning: string;
	reasoningComplete: boolean;
	/** Preserved DOM from chat container when the session is hidden. */
	savedDom: DocumentFragment | null;
	/** Event unsubscribers for this session. */
	unsubscribers: (() => void)[];
	/** Turn-level metadata accumulated while streaming (even in background). */
	turnStartTime: number;
	turnToolsUsed: string[];
	turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null;
	activeToolCalls: Map<string, {toolName: string; detailsEl: HTMLDetailsElement; startTime?: number}>;
	/** Streaming component for Markdown rendering. */
	streamingComponent: Component | null;
	streamingBodyEl: HTMLElement | null;
	streamingWrapperEl: HTMLElement | null;
	toolCallsContainer: HTMLElement | null;
	reasoningEl: HTMLDetailsElement | null;
	reasoningBodyEl: HTMLElement | null;
	/** Current plan's sub-tasks from the most recent `TodoWrite` call this turn, if any. */
	currentTodos: TodoItem[] | null;
	taskPanelEl: HTMLElement | null;
	/** Incrementally-built plan from `TaskCreate`/`TaskUpdate` calls this turn (taskId -> item). */
	taskPlan: Map<string, TodoItem>;
	/** `TaskCreate` calls awaiting their result (which carries the assigned task id). */
	pendingTaskCreates: Map<string, {subject: string; activeForm?: string}>;
}
