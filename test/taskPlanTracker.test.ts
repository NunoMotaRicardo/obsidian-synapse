import {describe, it, expect} from 'vitest';
import {TaskPlanTracker, type TaskPlanTrackerState} from '../src/taskPlanTracker';

// ---------------------------------------------------------------------------
// TaskPlanTracker (audit §3, issue #236) — the single owner of the
// TodoWrite/TaskCreate/TaskUpdate plan state both the foreground
// (synapseView.ts#handleSessionEvent) and background
// (sessionSidebar.ts#registerBackgroundEvents) paths previously mutated
// copy-pasted. DOM-free: handlers return `{handled, renderTodos}` and the
// caller decides whether to render.
// ---------------------------------------------------------------------------

describe('TaskPlanTracker — TodoWrite', () => {
	it('replaces currentTodos with the parsed plan and renders', () => {
		const tracker = new TaskPlanTracker();
		const result = tracker.onToolStart('TodoWrite', 'call-1', {
			todos: [
				{content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser'},
				{content: 'Deploy-test', status: 'in_progress', activeForm: 'Deploy-testing'},
			],
		});
		expect(result.handled).toBe(true);
		expect(result.renderTodos).toEqual([
			{content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser'},
			{content: 'Deploy-test', status: 'in_progress', activeForm: 'Deploy-testing'},
		]);
		expect(tracker.currentTodos).toEqual(result.renderTodos);
	});

	it('a later TodoWrite call fully replaces the previous plan', () => {
		const tracker = new TaskPlanTracker();
		tracker.onToolStart('TodoWrite', 'call-1', {todos: [{content: 'Old plan', status: 'pending'}]});
		const result = tracker.onToolStart('TodoWrite', 'call-2', {todos: [{content: 'New plan', status: 'in_progress'}]});
		expect(result.renderTodos).toEqual([{content: 'New plan', status: 'in_progress'}]);
		expect(tracker.currentTodos).toEqual([{content: 'New plan', status: 'in_progress'}]);
	});

	it('a malformed TodoWrite payload falls through to generic rendering', () => {
		const tracker = new TaskPlanTracker();
		const result = tracker.onToolStart('TodoWrite', 'call-1', {todos: 'not an array'});
		expect(result.handled).toBe(false);
		expect(result.renderTodos).toBeNull();
		expect(tracker.currentTodos).toBeNull();
	});
});

describe('TaskPlanTracker — TaskCreate', () => {
	it('stashes the parsed input on start (handled, no render) and adopts the result id on completion', () => {
		const tracker = new TaskPlanTracker();
		const start = tracker.onToolStart('TaskCreate', 'call-1', {subject: 'List files', activeForm: 'Listing files'});
		expect(start.handled).toBe(true);
		expect(start.renderTodos).toBeNull();
		expect(tracker.pendingTaskCreates.get('call-1')).toEqual({subject: 'List files', activeForm: 'Listing files'});

		const complete = tracker.onToolComplete('call-1', 'TaskCreate', {content: 'Task #3 created successfully: List files'});
		expect(complete.handled).toBe(true);
		expect(complete.renderTodos).toEqual([{content: 'List files', status: 'pending', activeForm: 'Listing files'}]);
		expect(tracker.taskPlan.get('3')).toEqual({content: 'List files', status: 'pending', activeForm: 'Listing files'});
		expect(tracker.pendingTaskCreates.has('call-1')).toBe(false);
	});

	it('consumes the stash on an errored result without adding a plan entry', () => {
		const tracker = new TaskPlanTracker();
		tracker.onToolStart('TaskCreate', 'call-1', {subject: 'List files'});
		const result = tracker.onToolComplete('call-1', 'TaskCreate', {content: ''}, {message: 'TaskCreate failed'});
		expect(result.handled).toBe(true);
		expect(result.renderTodos).toBeNull();
		expect(tracker.taskPlan.size).toBe(0);
		expect(tracker.pendingTaskCreates.has('call-1')).toBe(false);
	});

	it('falls through when the result text has no parseable id (stash consumed, nothing tracked)', () => {
		const tracker = new TaskPlanTracker();
		tracker.onToolStart('TaskCreate', 'call-1', {subject: 'List files'});
		const result = tracker.onToolComplete('call-1', 'TaskCreate', {content: 'Something else entirely'});
		expect(result.handled).toBe(true);
		expect(result.renderTodos).toBeNull();
		expect(tracker.taskPlan.size).toBe(0);
	});

	it('falls through for a malformed TaskCreate payload', () => {
		const tracker = new TaskPlanTracker();
		const result = tracker.onToolStart('TaskCreate', 'call-1', {subject: 42});
		expect(result.handled).toBe(false);
		expect(result.renderTodos).toBeNull();
	});
});

describe('TaskPlanTracker — TaskUpdate', () => {
	function seedPlan(tracker: TaskPlanTracker): void {
		tracker.onToolStart('TaskCreate', 'call-1', {subject: 'First task', activeForm: 'First-tasking'});
		tracker.onToolComplete('call-1', 'TaskCreate', {content: 'Task #1 created successfully: First task'});
	}

	it('patches an existing entry (status/subject/activeForm merge) and renders', () => {
		const tracker = new TaskPlanTracker();
		seedPlan(tracker);
		const result = tracker.onToolStart('TaskUpdate', 'call-2', {taskId: '1', status: 'in_progress', activeForm: 'First-tasking now'});
		expect(result.handled).toBe(true);
		expect(result.renderTodos).toEqual([{content: 'First task', status: 'in_progress', activeForm: 'First-tasking now'}]);
	});

	it("status 'deleted' removes the entry from the plan", () => {
		const tracker = new TaskPlanTracker();
		seedPlan(tracker);
		const result = tracker.onToolStart('TaskUpdate', 'call-2', {taskId: '1', status: 'deleted'});
		expect(result.handled).toBe(true);
		expect(result.renderTodos).toEqual([]);
		expect(tracker.taskPlan.size).toBe(0);
	});

	it('a dependency-only update (no visible change) is absorbed without a render', () => {
		const tracker = new TaskPlanTracker();
		seedPlan(tracker);
		const result = tracker.onToolStart('TaskUpdate', 'call-2', {taskId: '1', addBlockedBy: ['2']});
		expect(result.handled).toBe(false);
		expect(result.renderTodos).toBeNull();
		// The tracked entry is untouched.
		expect(tracker.taskPlan.get('1')).toEqual({content: 'First task', status: 'pending', activeForm: 'First-tasking'});
	});

	it('an update for an untracked taskId falls through (no fabricated entry)', () => {
		const tracker = new TaskPlanTracker();
		seedPlan(tracker);
		const result = tracker.onToolStart('TaskUpdate', 'call-2', {taskId: '99', status: 'in_progress'});
		expect(result.handled).toBe(false);
		expect(result.renderTodos).toBeNull();
		expect(tracker.taskPlan.size).toBe(1);
	});

	it('a malformed TaskUpdate payload falls through', () => {
		const tracker = new TaskPlanTracker();
		const result = tracker.onToolStart('TaskUpdate', 'call-1', {taskId: ''});
		expect(result.handled).toBe(false);
		expect(result.renderTodos).toBeNull();
	});
});

describe('TaskPlanTracker — reset / hasPlan / snapshot-restore', () => {
	it('reset() clears all three state holders', () => {
		const tracker = new TaskPlanTracker();
		tracker.onToolStart('TodoWrite', 'call-1', {todos: [{content: 'Plan item', status: 'pending'}]});
		tracker.onToolStart('TaskCreate', 'call-2', {subject: 'Stashed task'});
		tracker.onToolStart('TaskCreate', 'call-3', {subject: 'Adopted task'});
		tracker.onToolComplete('call-3', 'TaskCreate', {content: 'Task #1 created successfully: Adopted task'});
		expect(tracker.hasPlan).toBe(true);

		tracker.reset();
		expect(tracker.currentTodos).toBeNull();
		expect(tracker.taskPlan.size).toBe(0);
		expect(tracker.pendingTaskCreates.size).toBe(0);
		expect(tracker.hasPlan).toBe(false);
	});

	it('hasPlan is true for a TodoWrite-only plan (empty taskPlan) and false when empty', () => {
		const tracker = new TaskPlanTracker();
		expect(tracker.hasPlan).toBe(false);
		tracker.onToolStart('TodoWrite', 'call-1', {todos: [{content: 'Only todos', status: 'pending'}]});
		expect(tracker.taskPlan.size).toBe(0);
		expect(tracker.hasPlan).toBe(true);
	});

	it('snapshot/restore round-trips all three state holders (serializable-by-copy)', () => {
		const tracker = new TaskPlanTracker();
		tracker.onToolStart('TodoWrite', 'call-1', {todos: [{content: 'Plan item', status: 'in_progress', activeForm: 'Working'}]});
		tracker.onToolStart('TaskCreate', 'call-2', {subject: 'Adopted task'});
		tracker.onToolStart('TaskCreate', 'call-3', {subject: 'Stashed task', activeForm: 'Stashing'});
		tracker.onToolComplete('call-2', 'TaskCreate', {content: 'Task #7 created successfully: Adopted task'});

		const state: TaskPlanTrackerState = tracker.snapshot();
		// Serializable-by-copy: plain arrays (JSON-safe), not live Maps/class instances.
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);

		const restored = new TaskPlanTracker();
		restored.restore(state);
		expect(restored.currentTodos).toEqual([{content: 'Plan item', status: 'in_progress', activeForm: 'Working'}]);
		expect([...restored.taskPlan.entries()]).toEqual([['7', {content: 'Adopted task', status: 'pending'}]]);
		expect([...restored.pendingTaskCreates.entries()]).toEqual([['call-3', {subject: 'Stashed task', activeForm: 'Stashing'}]]);
		expect(restored.hasPlan).toBe(true);

		// Mutating the restored copy must not leak back into the snapshot source.
		restored.taskPlan.set('7', {content: 'Mutated', status: 'completed'});
		expect(tracker.taskPlan.get('7')!.content).toBe('Adopted task');
	});

	it('snapshot/restore of an empty tracker round-trips to a clean state', () => {
		const tracker = new TaskPlanTracker();
		const restored = new TaskPlanTracker();
		restored.restore(tracker.snapshot());
		expect(restored.hasPlan).toBe(false);
		expect(restored.currentTodos).toBeNull();
	});
});

describe('TaskPlanTracker — unrelated tool names fall through', () => {
	it('a non-plan tool start is not handled', () => {
		const tracker = new TaskPlanTracker();
		const result = tracker.onToolStart('Read', 'call-1', {file_path: 'notes/foo.md'});
		expect(result.handled).toBe(false);
		expect(result.renderTodos).toBeNull();
	});

	it('a non-plan tool completion is not handled', () => {
		const tracker = new TaskPlanTracker();
		const result = tracker.onToolComplete('call-1', 'Read', {content: 'file contents'});
		expect(result.handled).toBe(false);
		expect(result.renderTodos).toBeNull();
	});
});