/**
 * Task-plan tracking for the chat panel's task panel (extracted from `agentService.ts` —
 * audit §1/§3, issue #236).
 *
 * Owns the whole `TodoWrite`/`TaskCreate`/`TaskUpdate` plan-state machine in ONE place: the
 * parse functions previously in `agentService.ts` (moved verbatim, doc comments intact) and the
 * `TaskPlanTracker` class that replaces the copy-pasted foreground (`synapseView.ts`'s
 * `handleSessionEvent()`) and background (`sessionSidebar.ts`'s `registerBackgroundEvents()`)
 * plan-mutation branches. DOM-free — both callers render `renderTodos` through their own
 * rendering path, or ignore it (hidden session).
 *
 * Not part of the SDK service surface proper (it touches no SDK types) — but `agentService.ts`
 * re-exports `TodoItem`/`TaskPlan` and the four parse functions so the consumer import surface
 * (`../agentService`) stays unchanged.
 */

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

/** Plain-copy snapshot of a tracker's state, safe to hand across a background save/restore. */
export interface TaskPlanTrackerState {
	currentTodos: TodoItem[] | null;
	taskPlan: [string, TodoItem][];
	pendingTaskCreates: [string, {subject: string; activeForm?: string}][];
}

/**
 * Owns the task-plan state both the foreground (`synapseView.ts`'s `handleSessionEvent()`) and
 * background (`sessionSidebar.ts`'s `registerBackgroundEvents()`) event paths mutate — the
 * single implementation of the `TodoWrite` replace / `TaskCreate` stash-and-adopt /
 * `TaskUpdate` patch-delete semantics (audit §3, issue #236: exactly one `hasVisibleChange`
 * guard, one `status === 'deleted'` delete, one field-merge).
 *
 * DOM-free by design: the foreground caller renders `renderTodos` via its renderer when
 * non-null; the background caller ignores it (no DOM while hidden). Callers pass the raw
 * `tool.execution_start`/`tool.execution_complete` data; a `{handled: false, renderTodos: null}`
 * result means the event wasn't a consumed plan mutation and falls through to the caller's
 * generic tool-call rendering.
 */
export class TaskPlanTracker {
	/** Current plan's sub-tasks, from the most recent `TodoWrite` call this turn. `null` = no plan yet. */
	currentTodos: TodoItem[] | null = null;
	/** Incrementally-built plan from `TaskCreate`/`TaskUpdate` calls this turn (taskId -> item). */
	taskPlan: TaskPlan = new Map();
	/** `TaskCreate` calls awaiting their `tool.execution_complete` result, which carries the server-assigned task id. */
	pendingTaskCreates: Map<string, {subject: string; activeForm?: string}> = new Map();

	/**
	 * Handle one `tool.execution_start` event. Consumes the `TodoWrite`/`TaskCreate`/`TaskUpdate`
	 * branches the two call sites used to branch on inline:
	 *
	 * - `TodoWrite`: parse → replace `currentTodos` → render.
	 * - `TaskCreate`: parse → stash `{subject, activeForm}` keyed by `toolCallId` (the id is only
	 *   known once the result arrives) → handled, no render yet.
	 * - `TaskUpdate`: parse → the one `hasVisibleChange` guard → `taskPlan` membership check →
	 *   delete-on-`'deleted'` or field-merge → render.
	 *
	 * Malformed/unrecognized payloads, or a `TaskUpdate` for an untracked id, return
	 * `{handled: false, renderTodos: null}` so the caller falls through to generic tool-call
	 * rendering — same behavior as before the extraction. The one subtlety (matching `main`'s
	 * inline branch): a `TaskUpdate` for a *tracked* id that carries no displayable field is
	 * absorbed silently (`{handled: true, renderTodos: null}`) — no map mutation, no render, and
	 * no generic tool-call block — because `main`'s `break` sat inside the
	 * `parsed && taskPlan.has(taskId)` check.
	 */
	onToolStart(toolName: string, toolCallId: string, input: unknown): {handled: boolean; renderTodos: TodoItem[] | null} {
		if (toolName === 'TodoWrite') {
			const todos = parseTodoWritePayload(input);
			if (todos) {
				this.currentTodos = todos;
				return {handled: true, renderTodos: todos};
			}
			// Payload didn't look like a TodoWrite plan — fall through to generic rendering.
			return {handled: false, renderTodos: null};
		}
		if (toolName === 'TaskCreate') {
			const parsed = parseTaskCreateInput(input);
			if (parsed) {
				// The id is only known once the result arrives — stash the fields keyed by
				// toolCallId so tool.execution_complete can add the entry to taskPlan.
				this.pendingTaskCreates.set(toolCallId, parsed);
				return {handled: true, renderTodos: null};
			}
			return {handled: false, renderTodos: null};
		}
		if (toolName === 'TaskUpdate') {
			const parsed = parseTaskUpdateInput(input);
			if (parsed && this.taskPlan.has(parsed.taskId)) {
				// The CLI also emits TaskUpdate calls that only touch untracked fields
				// (e.g. dependencies) — parsed.status/subject/activeForm are all
				// undefined in that case. Absorb the event silently (no map mutation, no
				// render, no generic tool-call block) rather than churning the panel on
				// every dependency-only update during an agentic loop — this matches
				// main's inline branch, whose `break` sat inside this membership check.
				const hasVisibleChange = parsed.status !== undefined || parsed.subject !== undefined || parsed.activeForm !== undefined;
				if (hasVisibleChange) {
					if (parsed.status === 'deleted') {
						this.taskPlan.delete(parsed.taskId);
					} else {
						const existing = this.taskPlan.get(parsed.taskId)!;
						this.taskPlan.set(parsed.taskId, {
							content: parsed.subject ?? existing.content,
							status: parsed.status ?? existing.status,
							activeForm: parsed.activeForm ?? existing.activeForm,
						});
					}
					return {handled: true, renderTodos: [...this.taskPlan.values()]};
				}
				// Tracked id, nothing displayable to change — absorbed, don't fall through.
				return {handled: true, renderTodos: null};
			}
			return {handled: false, renderTodos: null};
		}
		return {handled: false, renderTodos: null};
	}

	/**
	 * Handle one `tool.execution_complete` event for the `TaskCreate` result branch: a pending
	 * stash hit extracts the server-assigned id from the result text (`parseTaskCreateResultId`,
	 * `null` on an errored result), adds a `{status: 'pending'}` entry to `taskPlan`, and renders.
	 * No pending stash for this `toolCallId` → `{handled: false, renderTodos: null}` so the
	 * caller falls through to its generic tool-call completion handling.
	 */
	onToolComplete(toolCallId: string, toolName: string | undefined, result: {content: string}, error?: {message: string}): {handled: boolean; renderTodos: TodoItem[] | null} {
		if (toolName === 'TaskCreate' && this.pendingTaskCreates.has(toolCallId)) {
			const pending = this.pendingTaskCreates.get(toolCallId)!;
			this.pendingTaskCreates.delete(toolCallId);
			const taskId = !error ? parseTaskCreateResultId(result.content) : null;
			if (taskId) {
				this.taskPlan.set(taskId, {content: pending.subject, status: 'pending', activeForm: pending.activeForm});
				return {handled: true, renderTodos: [...this.taskPlan.values()]};
			}
			// Stash consumed (error result or unparseable id) — handled, nothing to render.
			return {handled: true, renderTodos: null};
		}
		return {handled: false, renderTodos: null};
	}

	/** Clear all plan state (new turn, session switch, background idle/error). */
	reset(): void {
		this.currentTodos = null;
		this.taskPlan.clear();
		this.pendingTaskCreates.clear();
	}

	/**
	 * Serializable-by-copy snapshot for the background save/restore path (`BackgroundSession`
	 * carries this instead of the three mirrored fields). Plain arrays, so a structured clone
	 * survives; `restore()` re-hydrates the Maps.
	 */
	snapshot(): TaskPlanTrackerState {
		return {
			currentTodos: this.currentTodos === null ? null : [...this.currentTodos],
			taskPlan: [...this.taskPlan.entries()],
			pendingTaskCreates: [...this.pendingTaskCreates.entries()],
		};
	}

	/** Re-hydrate a `snapshot()` — replaces all current state with the restored copy. */
	restore(state: TaskPlanTrackerState): void {
		this.currentTodos = state.currentTodos === null ? null : [...state.currentTodos];
		this.taskPlan = new Map(state.taskPlan);
		this.pendingTaskCreates = new Map(state.pendingTaskCreates);
	}

	/**
	 * Whether any plan state exists (used by restore logic to decide on a re-render).
	 * Only checks `taskPlan` and `currentTodos` — a `TaskCreate` that has been stashed in
	 * `pendingTaskCreates` but not yet matched with its result id is not yet a displayable
	 * plan, so `hasPlan` stays false until the result arrives and the entry is adopted.
	 */
	get hasPlan(): boolean {
		return this.taskPlan.size > 0 || this.currentTodos !== null;
	}
}