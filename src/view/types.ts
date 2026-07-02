import type {Component} from 'obsidian';
import type {Session, TodoItem} from '../agentService';
import type {ChatMessage} from '../types';

/** State for a session that may be running in the background while the user views another session. */
export interface BackgroundSession {
	sessionId: string;
	session: Session;
	messages: ChatMessage[];
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
	turnSkillsUsed: string[];
	turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null;
	activeToolCalls: Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>;
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
