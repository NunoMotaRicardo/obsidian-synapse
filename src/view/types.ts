import type {App, Component} from 'obsidian';
import type SynapsePlugin from '../main';
import type {SynapseView} from '../synapseView';
import type {Session} from '../agentService';
import type {ChatMessage} from '../types';
import type {TaskPlanTracker, TaskPlanTrackerState} from '../taskPlanTracker';

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
	/** Scroll the chat container to the bottom if the user is already near it (see `SynapseView.scrollToBottom`). */
	scrollToBottom(): void;
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
	/**
	 * Task-plan state (TodoWrite/TaskCreate/TaskUpdate) as a tracker snapshot (audit §3, #236) —
	 * the foreground tracker's `snapshot()` on save, restored into the restored foreground
	 * tracker on re-attach. Serializable-by-copy (plain arrays re-hydrated into Maps).
	 */
	taskPlanTrackerState: TaskPlanTrackerState;
	/**
	 * The live tracker for this hidden session's `registerBackgroundEvents()` handlers —
	 * lazily hydrated from `taskPlanTrackerState` on first access and kept in sync with it
	 * (`restore()`ed from the snapshot when absent, so a save→restore round-trip through the
	 * state field is always authoritative).
	 */
	taskPlanTracker?: TaskPlanTracker;
	taskPanelEl: HTMLElement | null;
}
