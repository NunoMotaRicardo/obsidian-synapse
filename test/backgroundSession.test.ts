import {describe, it, expect} from 'vitest';
import {BackgroundSession} from '../src/view/backgroundSession';
import type {Session, SessionEvents} from '../src/agentService';

// ---------------------------------------------------------------------------
// BackgroundSession (audit §4, issue #237) — the background-session model owns
// its own state (messages, streaming accumulator, turn metadata, its own
// TaskPlanTracker) and exposes attach()/detach() for its Session event
// subscriptions, instead of being a struct the foreground view fills and
// drains via a saved DOM fragment. These tests exercise the model in
// isolation, with a fake `Session` exposing only the typed `on()` seam the
// model actually uses.
// ---------------------------------------------------------------------------

/** A fake `Session` that records handlers per event and lets tests fire them directly. */
function fakeSession() {
	type StoredHandler = (data: unknown) => void;
	const handlers = new Map<keyof SessionEvents, StoredHandler[]>();
	const session = {
		on<K extends keyof SessionEvents>(type: K, handler: (data: SessionEvents[K]) => void) {
			const storedHandler: StoredHandler = handler;
			const list = handlers.get(type) ?? [];
			list.push(storedHandler);
			handlers.set(type, list);
			return () => {
				const idx = list.indexOf(storedHandler);
				if (idx >= 0) list.splice(idx, 1);
			};
		},
	};
	const fire = <K extends keyof SessionEvents>(type: K, data: SessionEvents[K]) => {
		for (const handler of handlers.get(type) ?? []) handler(data);
	};
	return {session: session as unknown as Session, fire, handlerCount: (type: keyof SessionEvents) => (handlers.get(type) ?? []).length};
}

function makeBackgroundSession(session: Session, overrides?: Partial<ConstructorParameters<typeof BackgroundSession>[0]>) {
	return new BackgroundSession({
		sessionId: 'sess-1',
		session,
		messages: [],
		sessionToolGrants: new Set(),
		isStreaming: true,
		streamingContent: '',
		streamingReasoning: '',
		reasoningComplete: false,
		turnStartTime: 0,
		turnToolsUsed: [],
		turnUsage: null,
		...overrides,
	});
}

describe('BackgroundSession — no DOM ownership', () => {
	it('exposes only plain-data state, never DOM refs', () => {
		const {session} = fakeSession();
		const bg = makeBackgroundSession(session);
		// No DOM-owning fields exist on the instance at all (audit §4's ~15-field cut).
		expect('savedDom' in bg).toBe(false);
		expect('streamingBodyEl' in bg).toBe(false);
		expect('streamingComponent' in bg).toBe(false);
		expect('activeToolCalls' in bg).toBe(false);
		expect('taskPanelEl' in bg).toBe(false);
	});
});

describe('BackgroundSession — streaming accumulation while hidden', () => {
	it('accumulates message/reasoning deltas and usage without touching DOM', () => {
		const {session, fire} = fakeSession();
		const bg = makeBackgroundSession(session);
		bg.attach({onIdle: () => {}, onError: () => {}});

		fire('assistant.turn_start', {});
		fire('assistant.message_delta', {content: 'Hel', deltaContent: 'Hel'});
		fire('assistant.message_delta', {content: 'Hello', deltaContent: 'lo'});
		fire('assistant.reasoning_delta', {content: 'thinking', deltaContent: 'thinking'});
		fire('assistant.usage', {inputTokens: 10, outputTokens: 5, model: 'claude-x'});

		expect(bg.streamingContent).toBe('Hello');
		expect(bg.streamingReasoning).toBe('thinking');
		expect(bg.turnStartTime).toBeGreaterThan(0);
		expect(bg.turnUsage).toEqual({inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-x'});
	});

	it('finalizes the streamed turn into messages and resets turn state on session.idle', () => {
		const {session, fire} = fakeSession();
		let idleCalls = 0;
		const bg = makeBackgroundSession(session);
		bg.attach({onIdle: () => { idleCalls++; }, onError: () => {}});

		fire('assistant.message_delta', {content: 'Done', deltaContent: 'Done'});
		fire('assistant.reasoning_delta', {content: 'reason', deltaContent: 'reason'});
		fire('session.idle', {});

		expect(bg.messages).toHaveLength(1);
		expect(bg.messages[0]).toMatchObject({role: 'assistant', content: 'Done', reasoning: 'reason'});
		expect(bg.streamingContent).toBe('');
		expect(bg.streamingReasoning).toBe('');
		expect(bg.isStreaming).toBe(false);
		expect(idleCalls).toBe(1);
	});

	it('records an info message and resets on session.error', () => {
		const {session, fire} = fakeSession();
		let errorCalls = 0;
		const bg = makeBackgroundSession(session);
		bg.attach({onIdle: () => {}, onError: () => { errorCalls++; }});

		fire('assistant.message_delta', {content: 'partial', deltaContent: 'partial'});
		fire('session.error', {error: 'boom'});

		expect(bg.messages).toHaveLength(1);
		expect(bg.messages[0]).toMatchObject({role: 'info', content: 'Error: boom'});
		expect(bg.isStreaming).toBe(false);
		expect(errorCalls).toBe(1);
	});

	it('routes tool.execution_start/complete through its own TaskPlanTracker (TodoWrite)', () => {
		const {session, fire} = fakeSession();
		const bg = makeBackgroundSession(session);
		bg.attach({onIdle: () => {}, onError: () => {}});

		fire('tool.execution_start', {
			toolName: 'TodoWrite',
			toolCallId: 'call-1',
			input: {todos: [{content: 'Do a thing', status: 'pending'}]},
		});

		expect(bg.taskPlanTracker.currentTodos).toEqual([{content: 'Do a thing', status: 'pending'}]);
		expect(bg.turnToolsUsed).toEqual(['TodoWrite']);
	});
});

describe('BackgroundSession — attach/detach idempotence', () => {
	it('attach() is a no-op if already attached, and detach() unsubscribes all handlers', () => {
		const {session, fire, handlerCount} = fakeSession();
		const bg = makeBackgroundSession(session);
		bg.attach({onIdle: () => {}, onError: () => {}});
		bg.attach({onIdle: () => {}, onError: () => {}}); // second attach must not double-register
		expect(handlerCount('assistant.message_delta')).toBe(1);

		bg.detach();
		fire('assistant.message_delta', {content: 'x', deltaContent: 'x'});
		expect(bg.streamingContent).toBe(''); // handler no longer registered — event has no effect
	});
});
