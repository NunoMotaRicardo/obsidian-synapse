import {describe, it, expect, vi, type Mock} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {SessionSidebarController} from '../src/view/sessionSidebar';
import {BackgroundSession} from '../src/view/backgroundSession';
import {TaskPlanTracker} from '../src/taskPlanTracker';
import type {Session} from '../src/agentService';
import type {ChatMessage} from '../src/types';
import type {ViewContext} from '../src/view/types';

// ---------------------------------------------------------------------------
// Reviewer-flagged HIGH regression fix: `restoreFromBackground()` used to call
// `bg.detach()` *before* awaiting the history render, then only called
// `registerSessionEvents()` afterwards — leaving a window where neither `bg`
// (detached) nor the foreground `handleSessionEvent()` (not yet registered)
// was listening to the `Session`, silently dropping any SDK event that
// arrived in that gap (a final delta, a `tool.execution_complete`, or the
// terminal `session.idle`/`session.error`).
//
// The fix keeps `bg` attached through every `await` in the history-render
// path, then does `bg.detach()` immediately followed — with zero `await` in
// between — by `registerSessionEvents()`, so exactly one listener (`bg`, then
// the foreground handlers) is registered at every point in time. This is a
// structural regression guard on that ordering, expressed as a source-level
// assertion (same convention as `test/editorialSidebarSearch.test.ts`).
//
// Concurrency regression guard (PR 241 review comments):
// When selecting sessions concurrently or rapidly switching sessions, earlier
// restores must not overwrite later selections if their async renders complete
// late. A monotonic selection token guards every async boundary in
// `restoreFromBackground()` and `selectSession()`. If superseded, the earlier
// restore aborts cleanly, leaving `bg` safely attached in `activeSessions`.
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(__dirname, '..', 'src/view/sessionSidebar.ts'), 'utf8');

/** Extract a method's `{ ... }` body (brace-depth matched) by its declaration signature. */
function extractMethodBody(signaturePrefix: string): string {
	const start = source.indexOf(signaturePrefix);
	expect(start).toBeGreaterThan(-1);
	let i = source.indexOf('{', start);
	expect(i).toBeGreaterThan(-1);
	const bodyStart = i;
	let depth = 0;
	do {
		const ch = source.charAt(i);
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
		i++;
	} while (depth > 0 && i < source.length);
	return source.slice(bodyStart, i);
}

describe('restoreFromBackground — no listener-gap window (HIGH regression fix)', () => {
	const body = extractMethodBody('async restoreFromBackground(bg: BackgroundSession');

	it('detaches the background listener and registers foreground events with zero `await` in between', () => {
		const detachIdx = body.indexOf('bg.detach();');
		const registerIdx = body.indexOf('this.view.view.registerSessionEvents();');
		expect(detachIdx).toBeGreaterThan(-1);
		expect(registerIdx).toBeGreaterThan(detachIdx);

		const between = body.slice(detachIdx, registerIdx);
		expect(between).not.toContain('await ');
	});

	it('keeps `bg` attached through the history-render awaits — detach happens after, not before, them', () => {
		const firstRenderAwaitIdx = body.indexOf('await Promise.all(renderPromises)');
		const detachIdx = body.indexOf('bg.detach();');
		expect(firstRenderAwaitIdx).toBeGreaterThan(-1);
		expect(detachIdx).toBeGreaterThan(firstRenderAwaitIdx);
	});

	it('re-renders any message(s) bg pushed while history was rendering, before switching ownership', () => {
		const catchUpLoopIdx = body.indexOf('while (renderedCount < bg.messages.length)');
		const detachIdx = body.indexOf('bg.detach();');
		expect(catchUpLoopIdx).toBeGreaterThan(-1);
		expect(catchUpLoopIdx).toBeLessThan(detachIdx);
	});

	it('reads every view-adopted field from `bg` only after `bg.detach()` (not a pre-render stale snapshot)', () => {
		const detachIdx = body.indexOf('bg.detach();');
		// A representative sample of fields the view adopts from `bg` — each occurrence
		// must be after `bg.detach()`, not before it (the pre-fix ordering read them
		// before the render awaits, which could observe stale values).
		for (const fieldRead of [
			'this.view.view.isStreaming = bg.isStreaming;',
			'this.view.view.streamingContent = bg.streamingContent;',
			'this.view.view.turnUsage = bg.turnUsage;',
			'this.view.view.taskPlanTracker.restore(bg.taskPlanTracker.snapshot());',
		]) {
			const idx = body.indexOf(fieldRead);
			expect(idx).toBeGreaterThan(detachIdx);
		}
	});

	it('deletes the session from activeSessions within the atomic switch block (not after subsequent awaits)', () => {
		const detachIdx = body.indexOf('bg.detach();');
		const deleteIdx = body.indexOf('this.view.view.activeSessions.delete(bg.sessionId);');
		const registerIdx = body.indexOf('this.view.view.registerSessionEvents();');
		expect(deleteIdx).toBeGreaterThan(detachIdx);
		expect(deleteIdx).toBeLessThan(registerIdx);
	});

	it('guards against stale selection tokens before adopting background state', () => {
		const tokenCheck = 'if (this.selectionToken !== token) return;';
		const detachIdx = body.indexOf('bg.detach();');
		const lastCheckBeforeDetach = body.lastIndexOf(tokenCheck, detachIdx);
		expect(lastCheckBeforeDetach).toBeGreaterThan(-1);
	});
});

describe('concurrent session selection — behavioral regression tests', () => {
	interface MockViewForTest {
		activeSessions: Map<string, BackgroundSession>;
		sessionToolGrants: Set<string>;
		sessionNames: Record<string, string>;
		agents: {name: string; instructions: string}[];
		sessionList: {sessionId: string; createdAt?: number; lastModified?: number; summary?: string}[];
		isStreaming: boolean;
		streamingContent: string;
		streamingReasoning: string;
		reasoningComplete: boolean;
		turnStartTime: number;
		turnToolsUsed: string[];
		turnUsage: unknown;
		configDirty: boolean;
		lastFullRenderLen: number;
		taskPlanTracker: TaskPlanTracker;
		earlyEventBuffer: unknown[];
		streamingComponent: unknown;
		streamingBodyEl: unknown;
		streamingWrapperEl: unknown;
		toolCallsContainer: unknown;
		activeToolCalls: Map<string, unknown>;
		messages: ChatMessage[];
		currentSession: Session | null;
		currentSessionId: string | null;
		selectedAgent: string;
		selectedModel: string;
		configToolbar: {
			updateContextIndicator: ReturnType<typeof vi.fn>;
			selectAgent: ReturnType<typeof vi.fn>;
			populateModelSelect: ReturnType<typeof vi.fn>;
			getEffectiveAgents: ReturnType<typeof vi.fn>;
			resolveModelForAgent: ReturnType<typeof vi.fn>;
			applyAgentToolsAndSkills: ReturnType<typeof vi.fn>;
			updateReasoningBadge: ReturnType<typeof vi.fn>;
			updateCwdButton: ReturnType<typeof vi.fn>;
		};
		renderer: {
			clearReasoningState: ReturnType<typeof vi.fn>;
			clearTaskPanelState: ReturnType<typeof vi.fn>;
			renderWelcome: ReturnType<typeof vi.fn>;
			updateSendButton: ReturnType<typeof vi.fn>;
			addAssistantPlaceholder: ReturnType<typeof vi.fn>;
			syncReasoningContent: ReturnType<typeof vi.fn>;
			finalizeReasoning: ReturnType<typeof vi.fn>;
			updateStreamingRender: ReturnType<typeof vi.fn>;
			renderTaskPanel: ReturnType<typeof vi.fn>;
			addInfoMessage: ReturnType<typeof vi.fn>;
			renderMessageBubble: Mock<(msg: ChatMessage) => Promise<void>>;
		};
		registerSessionEvents: ReturnType<typeof vi.fn>;
		unsubscribeEvents: ReturnType<typeof vi.fn>;
		forceScrollToBottom: ReturnType<typeof vi.fn>;
		refreshComposerState: ReturnType<typeof vi.fn>;
		saveSessionNames: ReturnType<typeof vi.fn>;
		updateMastheadKicker: ReturnType<typeof vi.fn>;
		buildSessionConfig: ReturnType<typeof vi.fn>;
	}

	interface MockPluginForTest {
		agentService: {
			createSession: ReturnType<typeof vi.fn>;
			getSessionMessages: ReturnType<typeof vi.fn>;
		};
	}

	function createMockTestHarness() {
		let currentSessionId: string | null = null;
		let currentSession: Session | null = null;
		let messages: ChatMessage[] = [];
		const activeSessions = new Map<string, BackgroundSession>();
		const registeredEventHistory: (string | null)[] = [];

		const mockView: MockViewForTest = {
			activeSessions,
			sessionToolGrants: new Set(),
			sessionNames: {},
			agents: [],
			sessionList: [],
			isStreaming: false,
			streamingContent: '',
			streamingReasoning: '',
			reasoningComplete: false,
			turnStartTime: 0,
			turnToolsUsed: [],
			turnUsage: null,
			configDirty: false,
			lastFullRenderLen: 0,
			taskPlanTracker: new TaskPlanTracker(),
			earlyEventBuffer: [],
			streamingComponent: null,
			streamingBodyEl: null,
			streamingWrapperEl: null,
			toolCallsContainer: null,
			activeToolCalls: new Map(),
			messages: [],
			currentSession: null,
			currentSessionId: null,
			selectedAgent: '',
			selectedModel: '',
			configToolbar: {
				updateContextIndicator: vi.fn(),
				selectAgent: vi.fn(),
				populateModelSelect: vi.fn(),
				getEffectiveAgents: vi.fn().mockReturnValue([]),
				resolveModelForAgent: vi.fn(),
				applyAgentToolsAndSkills: vi.fn(),
				updateReasoningBadge: vi.fn(),
				updateCwdButton: vi.fn(),
			},
			renderer: {
				clearReasoningState: vi.fn(),
				clearTaskPanelState: vi.fn(),
				renderWelcome: vi.fn(),
				updateSendButton: vi.fn(),
				addAssistantPlaceholder: vi.fn(),
				syncReasoningContent: vi.fn(),
				finalizeReasoning: vi.fn(),
				updateStreamingRender: vi.fn().mockResolvedValue(undefined),
				renderTaskPanel: vi.fn(),
				addInfoMessage: vi.fn(),
				renderMessageBubble: vi.fn().mockResolvedValue(undefined),
			},
			registerSessionEvents: vi.fn(() => {
				registeredEventHistory.push(currentSessionId);
			}),
			unsubscribeEvents: vi.fn(),
			forceScrollToBottom: vi.fn(),
			refreshComposerState: vi.fn(),
			saveSessionNames: vi.fn(),
			updateMastheadKicker: vi.fn(),
			buildSessionConfig: vi.fn().mockReturnValue({}),
		};

		Object.defineProperty(mockView, 'messages', {
			get: () => messages,
			set: (val: ChatMessage[]) => { messages = val; },
		});
		Object.defineProperty(mockView, 'currentSession', {
			get: () => currentSession,
			set: (val: Session | null) => { currentSession = val; },
		});
		Object.defineProperty(mockView, 'currentSessionId', {
			get: () => currentSessionId,
			set: (val: string | null) => { currentSessionId = val; },
		});

		const mockPlugin: MockPluginForTest = {
			agentService: {
				createSession: vi.fn(),
				getSessionMessages: vi.fn().mockResolvedValue([]),
			},
		};

		const mockContext = {
			app: {} as unknown as ViewContext['app'],
			plugin: mockPlugin as unknown as ViewContext['plugin'],
			chatContainer: {
				empty: vi.fn(),
			} as unknown as HTMLElement,
			view: mockView as unknown as ViewContext['view'],
			isStreaming: false,
			scrollToBottom: vi.fn(),
			getVaultBasePath: vi.fn().mockReturnValue(''),
			getWorkingDirectory: vi.fn().mockReturnValue(''),
			configDirty: false,
		} satisfies ViewContext;

		const controller = new SessionSidebarController(mockContext);
		return {controller, mockView, mockPlugin, activeSessions, registeredEventHistory};
	}

	function createMockBackgroundSession(sessionId: string, messages: ChatMessage[] = [], isStreaming = false) {
		const unsubSpy = vi.fn();
		const mockSession = {
			sessionId,
			on: vi.fn().mockReturnValue(unsubSpy),
			disconnect: vi.fn().mockResolvedValue(undefined),
		} as unknown as Session;

		const bg = new BackgroundSession({
			sessionId,
			session: mockSession,
			messages: [...messages],
			sessionToolGrants: new Set(),
			isStreaming,
			streamingContent: '',
			streamingReasoning: '',
			reasoningComplete: false,
			turnStartTime: 0,
			turnToolsUsed: [],
			turnUsage: null,
		});

		// Attach so we can check if detach() is called
		bg.attach({onIdle: () => {}, onError: () => {}});
		const detachSpy = vi.spyOn(bg, 'detach');

		return {bg, mockSession, detachSpy, unsubSpy};
	}

	it('preserves the later session as foreground when an earlier background restore completes late', async () => {
		const {controller, mockView, activeSessions, registeredEventHistory} = createMockTestHarness();

		// Set up two background sessions
		const sessionAData = createMockBackgroundSession('session-a', [
			{id: 'msg-a', role: 'user', content: 'Message from A', timestamp: 1000},
		]);
		const sessionBData = createMockBackgroundSession('session-b', [
			{id: 'msg-b', role: 'user', content: 'Message from B', timestamp: 2000},
		]);

		activeSessions.set('session-a', sessionAData.bg);
		activeSessions.set('session-b', sessionBData.bg);

		// Defer Session A's message rendering to simulate a slow render
		let resolveRenderA!: () => void;
		const renderAPromise = new Promise<void>((resolve) => {
			resolveRenderA = resolve;
		});

		mockView.renderer.renderMessageBubble.mockImplementation(async (msg: ChatMessage) => {
			if (msg.id === 'msg-a') {
				await renderAPromise;
			}
		});

		// 1. User selects Session A (starts slow restore)
		const selectAPromise = controller.selectSession('session-a');

		// 2. User quickly selects Session B while Session A is still awaiting
		await controller.selectSession('session-b');

		// At this point Session B should have completed restore and become foreground
		expect(mockView.currentSessionId).toBe('session-b');
		expect(mockView.currentSession).toBe(sessionBData.mockSession);
		expect(sessionBData.detachSpy).toHaveBeenCalledTimes(1);
		expect(activeSessions.has('session-b')).toBe(false);

		// Session A should still be in activeSessions and NOT yet detached
		expect(activeSessions.has('session-a')).toBe(true);
		expect(sessionAData.detachSpy).not.toHaveBeenCalled();

		// 3. Now Session A's slow render finishes
		resolveRenderA();
		await selectAPromise;

		// 4. Verification: Session B remains foreground!
		expect(mockView.currentSessionId).toBe('session-b');
		expect(mockView.currentSession).toBe(sessionBData.mockSession);

		// Session A's restore aborted cleanly without adopting foreground or detaching its listener
		expect(sessionAData.detachSpy).not.toHaveBeenCalled();
		expect(activeSessions.has('session-a')).toBe(true);

		// Session events were registered for Session B, never for Session A
		expect(registeredEventHistory).toEqual(['session-b']);
	});

	it('invalidates in-flight background restore when newConversation() is invoked', async () => {
		const {controller, mockView, activeSessions} = createMockTestHarness();

		const sessionAData = createMockBackgroundSession('session-a', [
			{id: 'msg-a', role: 'user', content: 'Message from A', timestamp: 1000},
		]);
		activeSessions.set('session-a', sessionAData.bg);

		let resolveRenderA!: () => void;
		const renderAPromise = new Promise<void>((resolve) => {
			resolveRenderA = resolve;
		});

		mockView.renderer.renderMessageBubble.mockImplementation(async (msg: ChatMessage) => {
			if (msg.id === 'msg-a') {
				await renderAPromise;
			}
		});

		// 1. User selects Session A
		const selectAPromise = controller.selectSession('session-a');

		// 2. User clicks New Conversation
		controller.cancelInFlightSelection();
		mockView.currentSessionId = null;
		mockView.currentSession = null;

		// 3. Session A's render completes
		resolveRenderA();
		await selectAPromise;

		// Verification: view remains in new conversation state
		expect(mockView.currentSessionId).toBeNull();
		expect(mockView.currentSession).toBeNull();
		expect(activeSessions.has('session-a')).toBe(true);
		expect(sessionAData.detachSpy).not.toHaveBeenCalled();
	});

	it('disconnects and ignores an in-flight cold load when superseded by another session', async () => {
		const {controller, mockView, mockPlugin, activeSessions} = createMockTestHarness();

		const sessionBData = createMockBackgroundSession('session-b', [
			{id: 'msg-b', role: 'user', content: 'Message from B', timestamp: 2000},
		]);
		activeSessions.set('session-b', sessionBData.bg);

		const disconnectSpy = vi.fn().mockResolvedValue(undefined);
		const coldSession = {
			sessionId: 'cold-session',
			on: vi.fn(),
			disconnect: disconnectSpy,
		} as unknown as Session;

		let resolveCreateSession!: () => void;
		const createSessionPromise = new Promise<Session>((resolve) => {
			resolveCreateSession = () => resolve(coldSession);
		});
		mockPlugin.agentService.createSession.mockReturnValue(createSessionPromise);

		// 1. User selects cold-session (starts async createSession)
		const selectColdPromise = controller.selectSession('cold-session');

		// 2. User selects session-b from background
		await controller.selectSession('session-b');
		expect(mockView.currentSessionId).toBe('session-b');

		// 3. Cold createSession completes
		resolveCreateSession();
		await selectColdPromise;

		// Verification: cold session was disconnected and did not overwrite session-b
		expect(disconnectSpy).toHaveBeenCalled();
		expect(mockView.currentSessionId).toBe('session-b');
		expect(mockView.currentSession).toBe(sessionBData.mockSession);
	});
});
