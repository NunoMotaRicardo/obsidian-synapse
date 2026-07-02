import {describe, it, expect} from 'vitest';
import {parseTodoWritePayload} from '../src/agentService';

// ---------------------------------------------------------------------------
// parseTodoWritePayload — normalizes a TodoWrite tool call's `input` into a
// TodoItem[] for the task-tracking panel (issue #87). Parsed defensively:
// the payload shape isn't part of the SDK's typed public surface.
// ---------------------------------------------------------------------------

describe('parseTodoWritePayload', () => {
	it('returns null for non-object input', () => {
		expect(parseTodoWritePayload(null)).toBeNull();
		expect(parseTodoWritePayload(undefined)).toBeNull();
		expect(parseTodoWritePayload('not an object')).toBeNull();
		expect(parseTodoWritePayload(42)).toBeNull();
	});

	it('returns null when input has no todos array', () => {
		expect(parseTodoWritePayload({})).toBeNull();
		expect(parseTodoWritePayload({todos: 'not an array'})).toBeNull();
		expect(parseTodoWritePayload({file_path: '/foo.md'})).toBeNull();
	});

	it('returns an empty array for a valid but empty todo list', () => {
		expect(parseTodoWritePayload({todos: []})).toEqual([]);
	});

	it('parses a well-formed todo list', () => {
		const result = parseTodoWritePayload({
			todos: [
				{content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser'},
				{content: 'Wire up the view', status: 'in_progress', activeForm: 'Wiring up the view'},
				{content: 'Deploy-test', status: 'pending', activeForm: 'Deploy-testing'},
			],
		});
		expect(result).toEqual([
			{content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser'},
			{content: 'Wire up the view', status: 'in_progress', activeForm: 'Wiring up the view'},
			{content: 'Deploy-test', status: 'pending', activeForm: 'Deploy-testing'},
		]);
	});

	it('defaults an unrecognized or missing status to pending', () => {
		const result = parseTodoWritePayload({
			todos: [
				{content: 'No status field'},
				{content: 'Weird status', status: 'blocked'},
				{content: 'Null status', status: null},
			],
		});
		expect(result).toEqual([
			{content: 'No status field', status: 'pending'},
			{content: 'Weird status', status: 'pending'},
			{content: 'Null status', status: 'pending'},
		]);
	});

	it('omits activeForm when absent or not a string', () => {
		const result = parseTodoWritePayload({
			todos: [
				{content: 'No active form', status: 'pending'},
				{content: 'Numeric active form', status: 'pending', activeForm: 42},
				{content: 'Empty active form', status: 'pending', activeForm: ''},
			],
		});
		expect(result).toEqual([
			{content: 'No active form', status: 'pending'},
			{content: 'Numeric active form', status: 'pending'},
			{content: 'Empty active form', status: 'pending'},
		]);
	});

	it('skips entries with no content or a non-string content', () => {
		const result = parseTodoWritePayload({
			todos: [
				{status: 'pending'},
				{content: '', status: 'pending'},
				{content: 42, status: 'pending'},
				{content: 'Valid entry', status: 'pending'},
			],
		});
		expect(result).toEqual([{content: 'Valid entry', status: 'pending'}]);
	});

	it('skips non-object entries within the todos array', () => {
		const result = parseTodoWritePayload({
			todos: [null, 'a string', 42, {content: 'Valid entry', status: 'completed'}],
		});
		expect(result).toEqual([{content: 'Valid entry', status: 'completed'}]);
	});

	it('ignores unrelated tool input shapes (e.g. a Write tool call)', () => {
		expect(parseTodoWritePayload({file_path: '/notes/foo.md', content: 'hello'})).toBeNull();
	});
});
