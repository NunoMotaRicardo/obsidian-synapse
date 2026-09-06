import {describe, it, expect} from 'vitest';
import {parseTodoWritePayload, parseTaskCreateInput, parseTaskCreateResultId, parseTaskUpdateInput, AgentService, Session, mapSdkModel} from '../src/agentService';
import type {SDKModelInfo} from '../src/agentService';

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

// ---------------------------------------------------------------------------
// parseTaskCreateInput / parseTaskCreateResultId / parseTaskUpdateInput —
// the newer TaskCreate/TaskUpdate planning tool family observed from the
// installed CLI (sdk-tools.d.ts: TaskCreateInput/TaskUpdateInput), which
// builds a plan incrementally across multiple tool calls rather than one
// full-state TodoWrite call.
// ---------------------------------------------------------------------------

describe('parseTaskCreateInput', () => {
	it('returns null for non-object input', () => {
		expect(parseTaskCreateInput(null)).toBeNull();
		expect(parseTaskCreateInput(undefined)).toBeNull();
		expect(parseTaskCreateInput('nope')).toBeNull();
	});

	it('returns null when subject is missing or not a string', () => {
		expect(parseTaskCreateInput({description: 'no subject'})).toBeNull();
		expect(parseTaskCreateInput({subject: 42})).toBeNull();
		expect(parseTaskCreateInput({subject: ''})).toBeNull();
	});

	it('parses subject and activeForm', () => {
		expect(parseTaskCreateInput({subject: 'List files', description: 'ignored here', activeForm: 'Listing files'}))
			.toEqual({subject: 'List files', activeForm: 'Listing files'});
	});

	it('omits activeForm when absent or not a non-empty string', () => {
		expect(parseTaskCreateInput({subject: 'List files'})).toEqual({subject: 'List files'});
		expect(parseTaskCreateInput({subject: 'List files', activeForm: 42})).toEqual({subject: 'List files'});
		expect(parseTaskCreateInput({subject: 'List files', activeForm: ''})).toEqual({subject: 'List files'});
	});
});

describe('parseTaskCreateResultId', () => {
	it('extracts the id from the observed CLI result format', () => {
		expect(parseTaskCreateResultId('Task #1 created successfully: List files in the vault root')).toBe('1');
		expect(parseTaskCreateResultId('Task #abc-123 created successfully: Some subject')).toBe('abc-123');
	});

	it('returns null for undefined, empty, or non-matching text', () => {
		expect(parseTaskCreateResultId(undefined)).toBeNull();
		expect(parseTaskCreateResultId('')).toBeNull();
		expect(parseTaskCreateResultId('Something else entirely')).toBeNull();
		expect(parseTaskCreateResultId('created Task #1 successfully')).toBeNull();
	});
});

describe('parseTaskUpdateInput', () => {
	it('returns null for non-object input', () => {
		expect(parseTaskUpdateInput(null)).toBeNull();
		expect(parseTaskUpdateInput(undefined)).toBeNull();
	});

	it('returns null when taskId is missing or not a string', () => {
		expect(parseTaskUpdateInput({status: 'completed'})).toBeNull();
		expect(parseTaskUpdateInput({taskId: 42, status: 'completed'})).toBeNull();
		expect(parseTaskUpdateInput({taskId: ''})).toBeNull();
	});

	it('parses a status-only update (the common in_progress/completed transition)', () => {
		expect(parseTaskUpdateInput({taskId: '1', status: 'in_progress'})).toEqual({taskId: '1', status: 'in_progress'});
		expect(parseTaskUpdateInput({taskId: '1', status: 'completed'})).toEqual({taskId: '1', status: 'completed'});
	});

	it('recognizes the deleted status (not a valid TodoItem status, tracked separately for removal)', () => {
		expect(parseTaskUpdateInput({taskId: '1', status: 'deleted'})).toEqual({taskId: '1', status: 'deleted'});
	});

	it('ignores an unrecognized status value', () => {
		expect(parseTaskUpdateInput({taskId: '1', status: 'blocked'})).toEqual({taskId: '1'});
	});

	it('parses subject and activeForm patches alongside status', () => {
		expect(parseTaskUpdateInput({taskId: '2', status: 'in_progress', subject: 'New subject', activeForm: 'Doing it'}))
			.toEqual({taskId: '2', status: 'in_progress', subject: 'New subject', activeForm: 'Doing it'});
	});

	it('returns a dependency-only update with just the taskId (no status/subject/activeForm)', () => {
		// e.g. {taskId: '2', addBlockedBy: ['1']} — dependency fields aren't tracked in the panel
		expect(parseTaskUpdateInput({taskId: '2', addBlockedBy: ['1']})).toEqual({taskId: '2'});
	});
});

// ---------------------------------------------------------------------------
// AgentService#isLocalModel — issue #118. A local provider's `/v1/models`
// catalogue (setCustomModels()) can contain ids that collide with, or merely
// resemble, genuine Claude model ids (an SDK-known id, or any `claude-*`-shaped
// id — real SDK ids are always `claude-*`, so that prefix guard is what actually
// protects a Claude id even before a `fetchModels()` call has populated the
// SDK model list). Those must never be classified "local" regardless of what a
// provider catalogue happens to contain, or the plugin silently drops Claude
// models into the degraded local one-shot loop (no skills, subagents,
// sessions, permissions or streaming).
// ---------------------------------------------------------------------------

describe('AgentService#isLocalModel', () => {
	function makeLocalBackedService(): AgentService {
		return new AgentService({
			providerConfig: {preset: 'openai', baseUrl: 'http://localhost:1234/v1'},
		});
	}

	it('returns undefined/false for an undefined model id', () => {
		const service = makeLocalBackedService();
		expect(service.isLocalModel(undefined)).toBe(false);
	});

	it('never classifies a claude-* (SDK-shaped) model id as local, even if it also appears in customModels', () => {
		const service = makeLocalBackedService();
		// Simulates a provider catalogue that happens to echo a real Claude id
		// (e.g. the removed `anthropic` preset's /v1/models response).
		service.setCustomModels([{id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5'}]);
		expect(service.isLocalModel('claude-sonnet-4-5-20250929')).toBe(false);
	});

	it('classifies a genuine custom/local model id as local', () => {
		const service = makeLocalBackedService();
		service.setCustomModels([{id: 'llama3.1:8b', name: 'Llama 3.1 8B'}]);
		expect(service.isLocalModel('llama3.1:8b')).toBe(true);
	});

	it('classifies an aggregator-style id (e.g. anthropic/claude-sonnet-4) as local', () => {
		const service = makeLocalBackedService();
		// OpenRouter-style ids are namespaced (`anthropic/claude-sonnet-4`), so they don't
		// match the /^claude-/i guard and are treated as a distinct local/custom model.
		service.setCustomModels([{id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (via OpenRouter)'}]);
		expect(service.isLocalModel('anthropic/claude-sonnet-4')).toBe(true);
	});

	it('does not classify a claude-* id as local when no local backend is configured', () => {
		const service = new AgentService();
		expect(service.isLocalModel('claude-sonnet-4-5-20250929')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// mapSdkModel — issue #105. mapSdkModel must stop inventing capabilities
// (`max_context_window_tokens`, blanket `vision`/`tools`) and instead adopt
// only the real fields the SDK's ModelInfo publishes.
// ---------------------------------------------------------------------------

function makeSdkModel(overrides: Partial<SDKModelInfo> = {}): SDKModelInfo {
	return {
		value: 'sonnet',
		displayName: 'Sonnet',
		description: 'Balanced model for everyday tasks',
		...overrides,
	};
}

describe('mapSdkModel', () => {
	it('never invents vision or tool support', () => {
		const result = mapSdkModel(makeSdkModel());
		expect(result.isVision).toBeUndefined();
		expect(result.supportsTools).toBeUndefined();
		expect(result.capabilities?.supports?.vision).toBeUndefined();
		expect(result.capabilities?.supports?.tools).toBeUndefined();
	});

	it('never stamps a context-window limit', () => {
		const result = mapSdkModel(makeSdkModel());
		expect(result.capabilities?.limits).toBeUndefined();
	});

	it('maps the model id via sdkModelId (default -> empty id)', () => {
		expect(mapSdkModel(makeSdkModel({value: 'default'})).id).toBe('');
		expect(mapSdkModel(makeSdkModel({value: 'sonnet[1m]'})).id).toBe('sonnet[1m]');
	});

	it('carries resolvedModel, description and the mode-support fields through unchanged', () => {
		const result = mapSdkModel(makeSdkModel({
			value: 'sonnet',
			resolvedModel: 'claude-sonnet-5',
			description: 'Fast, balanced everyday model',
			supportsAdaptiveThinking: true,
			supportsFastMode: true,
			supportsAutoMode: false,
		}));
		expect(result.resolvedModel).toBe('claude-sonnet-5');
		expect(result.description).toBe('Fast, balanced everyday model');
		expect(result.supportsAdaptiveThinking).toBe(true);
		expect(result.supportsFastMode).toBe(true);
		expect(result.supportsAutoMode).toBe(false);
	});

	it('leaves resolvedModel/description/mode-support fields absent when the SDK omits them', () => {
		const result = mapSdkModel(makeSdkModel());
		expect(result.resolvedModel).toBeUndefined();
		expect(result.supportsAdaptiveThinking).toBeUndefined();
		expect(result.supportsFastMode).toBeUndefined();
		expect(result.supportsAutoMode).toBeUndefined();
	});

	it('derives reasoningEffort from supportsEffort when present', () => {
		const result = mapSdkModel(makeSdkModel({supportsEffort: true, supportedEffortLevels: ['low', 'high']}));
		expect(result.capabilities?.supports?.reasoningEffort).toBe(true);
		expect(result.capabilities?.supportedReasoningEfforts).toEqual(['low', 'high']);
	});

	it('falls back to effort-levels presence for reasoningEffort when supportsEffort is absent', () => {
		const result = mapSdkModel(makeSdkModel({supportedEffortLevels: ['medium']}));
		expect(result.capabilities?.supports?.reasoningEffort).toBe(true);
	});

	it('omits supportedReasoningEfforts when there are no effort levels', () => {
		const result = mapSdkModel(makeSdkModel());
		expect(result.capabilities?.supportedReasoningEfforts).toBeUndefined();
		expect(result.capabilities?.supports?.reasoningEffort).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AgentService#resolveValidModel — resolvedModel exact-match tier (#105).
// A persisted explicit/canonical id (e.g. 'claude-sonnet-5') should resolve
// deterministically to the alias row it belongs to via `resolvedModel`,
// rather than relying on the substring/keyword heuristics below it.
// ---------------------------------------------------------------------------

describe('AgentService#resolveValidModel — resolvedModel matching', () => {
	it('matches a canonical id against a row\'s resolvedModel before falling back to substring heuristics', () => {
		const service = new AgentService();
		service.setCustomModels([
			{id: 'sonnet', name: 'Sonnet', resolvedModel: 'claude-sonnet-5'},
			{id: 'opus', name: 'Opus', resolvedModel: 'claude-opus-5'},
		]);
		expect(service.resolveValidModel('claude-sonnet-5')).toBe('sonnet');
		expect(service.resolveValidModel('CLAUDE-OPUS-5')).toBe('opus');
	});

	it('still falls back to substring/keyword heuristics when no row has a matching resolvedModel', () => {
		const service = new AgentService();
		service.setCustomModels([{id: 'my-sonnet-mirror', name: 'Sonnet Mirror'}]);
		expect(service.resolveValidModel('sonnet')).toBe('my-sonnet-mirror');
	});
});

// ---------------------------------------------------------------------------
// Session#convertToSessionEvent — compact_boundary mapping (issue #177).
// An SDKCompactBoundaryMessage carrying compact_metadata should map to a
// populated `session.compaction_complete` event. The SDK only emits
// `compact_boundary` on success, so the payload carries no success/failure
// flag (see #181).
// ---------------------------------------------------------------------------

describe('Session#convertToSessionEvent — compact_boundary mapping', () => {
	function convert(msg: unknown): unknown {
		const session = new Session(new AgentService(), {});
		return (session as unknown as {convertToSessionEvent: (m: unknown) => unknown}).convertToSessionEvent(msg);
	}

	it('maps a compact_boundary message with full metadata into a populated session.compaction_complete payload', () => {
		const event = convert({
			type: 'system',
			subtype: 'compact_boundary',
			compact_metadata: {
				trigger: 'manual',
				pre_tokens: 150000,
				post_tokens: 45000,
				duration_ms: 3200,
			},
			uuid: 'mock-uuid',
			session_id: 'mock-session',
		});

		expect(event).toEqual({
			type: 'session.compaction_complete',
			data: {
				preCompactionTokens: 150000,
				postCompactionTokens: 45000,
				durationMs: 3200,
				trigger: 'manual',
			},
		});
	});

	it('passes through undefined for optional metadata fields when omitted from the SDK message', () => {
		const event = convert({
			type: 'system',
			subtype: 'compact_boundary',
			compact_metadata: {
				trigger: 'auto',
				pre_tokens: 100000,
			},
			uuid: 'mock-uuid',
			session_id: 'mock-session',
		});

		expect(event).toEqual({
			type: 'session.compaction_complete',
			data: {
				preCompactionTokens: 100000,
				postCompactionTokens: undefined,
				durationMs: undefined,
				trigger: 'auto',
			},
		});
	});
});

