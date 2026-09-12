import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {requestUrl} from 'obsidian';
import type {App} from 'obsidian';
import type SynapsePlugin from '../src/main';
import {TelegramBotService} from '../src/bots/telegramBot';
import {TelegramApiError} from '../src/bots/telegramApi';
import type {TelegramApiLike, TelegramFile, TelegramMessage, TelegramUpdate, TelegramUser} from '../src/bots/telegramApi';
import type {BotConnectionStatus} from '../src/bots/types';
import {createMockApp} from './setup';

// ---------------------------------------------------------------------------
// Issue #233 — test telegramBot behind an injected TelegramApi fake adapter.
//
// `TelegramBotService` takes its Telegram adapter through a constructor factory
// (defaulting to the real `TelegramApi` — production behavior unchanged), so
// every test here builds the bot against `FakeTelegramApi`: a structural
// `TelegramApiLike` implementation that records every call and lets tests
// program poll results.
//
// `handleMessage` is private, so nothing reaches into it — each test drives the
// real public path from `connect()`: `pollLoop()` long-polls the fake, and
// `pushUpdates()` resolves the parked poll (mirroring the real 30s long-poll
// without any test waiting on it). The 5s typing interval and the 5s poll
// backoff run under fake timers; `inlineChat` is a mock on the plugin object
// (no live CLI), with optional "gates" that park a reply until a test releases
// it — that is how per-chat serialization and the typing loop are observed
// deterministically.
// ---------------------------------------------------------------------------

/** Telegram's per-message limit, as enforced by the bot's splitMessage(). */
const TG_MAX_LENGTH = 4096;
/** The bot's typing refresh interval (matches TYPING_INTERVAL in telegramBot.ts). */
const TYPING_INTERVAL = 5000;
/** The bot's poll-error backoff (window.setTimeout in pollLoop()). */
const POLL_BACKOFF_MS = 5000;
/** Vault base path the mock app's adapter reports (getVaultBasePath()). */
const VAULT_BASE = 'C:/mock-vault';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain pending microtasks (poll dispatch, queue chaining, async fakes). */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

/** Mirrors Obsidian's normalizePath as stubbed in test/setup.ts. */
function normalizeMockPath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

let nextMessageId = 1;
let nextUpdateId = 1;

/** A private-chat message from an allowed user unless overridden. */
function userMessage(overrides: Partial<TelegramMessage> & {chatId?: number; senderId?: number; threadId?: number} = {}): TelegramMessage {
	const {chatId = 100, senderId = 111, threadId, ...rest} = overrides;
	return {
		message_id: nextMessageId++,
		from: {id: senderId, is_bot: false, first_name: 'Test User'},
		chat: {id: chatId, type: 'private'},
		date: 0,
		text: 'hello',
		...(threadId != null ? {message_thread_id: threadId} : {}),
		...rest,
	};
}

// ---------------------------------------------------------------------------
// FakeTelegramApi — the injected adapter. Records every call; `pushUpdates`
// feeds the poll loop (buffered even before the first getUpdates call), and
// `failPendingPoll` rejects an in-flight long-poll to exercise the backoff.
// ---------------------------------------------------------------------------

interface SentMessage {
	chat_id: number;
	text: string;
	message_thread_id?: number;
	parse_mode?: 'MarkdownV2' | 'HTML';
	reply_to_message_id?: number;
	disable_web_page_preview?: boolean;
}

interface InlineChatCall {
	prompt: string;
	profile?: string;
	resume?: string;
	timeoutMs?: number;
	abortController?: AbortController;
}

interface PendingGate {
	match: string;
	released: boolean;
	taken: boolean;
	resolve?: () => void;
}

class FakeTelegramApi implements TelegramApiLike {
	readonly token: string;
	getMeCalls = 0;
	getMeError?: Error;
	getUpdatesCalls: Array<{offset?: number; timeout?: number}> = [];
	sentMessages: SentMessage[] = [];
	sendMessageAttempts = 0;
	/** One-shot rejections consumed by the first `sendMessage` calls. */
	queuedSendMessageErrors: unknown[] = [];
	chatActions: Array<{chat_id: number; action: string; message_thread_id?: number}> = [];
	getFileCalls: string[] = [];
	fileResponses: Record<string, TelegramFile> = {};
	downloadCalls: string[] = [];
	downloadResponses: Record<string, ArrayBuffer> = {};

	private pendingUpdates: TelegramUpdate[] = [];
	private waitingPoll: {
		resolve: (updates: TelegramUpdate[]) => void;
		reject: (err: unknown) => void;
	} | null = null;

	constructor(token: string) {
		this.token = token;
	}

	async getMe(): Promise<TelegramUser> {
		this.getMeCalls++;
		if (this.getMeError !== undefined) {
			// Typed Error | undefined (only-throw-error) — tests store a real
			// Error/TelegramApiError here, just like the real client throws.
			throw this.getMeError;
		}
		return {id: 42, is_bot: true, first_name: 'Synapse Test Bot', username: 'synapse_test_bot'};
	}

	async getUpdates(offset?: number, timeout?: number): Promise<TelegramUpdate[]> {
		this.getUpdatesCalls.push({offset, timeout});
		const ready = this.pendingUpdates;
		if (ready.length > 0) {
			this.pendingUpdates = [];
			return ready;
		}
		// Park until pushUpdates()/failPendingPoll() — mirrors the real 30s
		// long-poll without any test waiting on it.
		return new Promise<TelegramUpdate[]>((resolve, reject) => {
			this.waitingPoll = {resolve, reject};
		});
	}

	/** Program the next poll result (buffered even before the first getUpdates call). */
	pushUpdates(updates: TelegramUpdate[]): void {
		this.pendingUpdates.push(...updates);
		const waiting = this.waitingPoll;
		if (waiting) {
			const ready = this.pendingUpdates;
			this.pendingUpdates = [];
			this.waitingPoll = null;
			waiting.resolve(ready);
		}
	}

	/** Reject an in-flight long-poll (exercises pollLoop's error/backoff path). */
	failPendingPoll(error: Error): void {
		const waiting = this.waitingPoll;
		if (waiting) {
			this.waitingPoll = null;
			waiting.reject(error);
		}
	}

	async sendMessage(params: SentMessage): Promise<TelegramMessage> {
		this.sendMessageAttempts++;
		if (this.queuedSendMessageErrors.length > 0) {
			throw this.queuedSendMessageErrors.shift();
		}
		this.sentMessages.push({...params});
		return {
			message_id: 9000 + this.sentMessages.length,
			chat: {id: params.chat_id, type: 'private'},
			date: 0,
			text: params.text,
		};
	}

	async sendChatAction(params: {chat_id: number; action: string; message_thread_id?: number}): Promise<boolean> {
		this.chatActions.push(params);
		return true;
	}

	async getFile(fileId: string): Promise<TelegramFile> {
		this.getFileCalls.push(fileId);
		return this.fileResponses[fileId] ?? {file_id: fileId, file_unique_id: `u_${fileId}`, file_path: `files/${fileId}`};
	}

	async downloadFile(filePath: string): Promise<ArrayBuffer> {
		this.downloadCalls.push(filePath);
		return this.downloadResponses[filePath] ?? new ArrayBuffer(4);
	}
}

// ---------------------------------------------------------------------------
// Harness — bot + fake + mock plugin (inlineChat mock with release gates) +
// a mock app whose adapter has the methods downloadAttachments() calls.
// ---------------------------------------------------------------------------

interface Harness {
	bot: TelegramBotService;
	fake: FakeTelegramApi;
	/** Live view of fake.sentMessages — replies are the suite's main assertion surface. */
	sentMessages: SentMessage[];
	/** Tokens seen by the injected factory (empty when the default factory ran). */
	factoryTokens: string[];
	statuses: BotConnectionStatus[];
	inlineChatCalls: InlineChatCall[];
	written: Array<{path: string; data: ArrayBuffer}>;
	mkdirCalls: string[];
	gate: (match: string) => void;
	releaseGate: (match: string) => void;
	onReply: (make: (prompt: string) => {content: string | undefined; sessionId: string}) => void;
	send: (msg: TelegramMessage) => void;
	stop: () => Promise<void>;
}

let currentHarness: Harness | null = null;

function makeHarness(opts?: {allowedUsers?: string; defaultFactory?: boolean}): Harness {
	const fake = new FakeTelegramApi('TEST_TOKEN');
	const factoryTokens: string[] = [];
	const statuses: BotConnectionStatus[] = [];
	const inlineChatCalls: InlineChatCall[] = [];
	const gates: PendingGate[] = [];
	let makeReply: (prompt: string) => {content: string | undefined; sessionId: string} =
		(prompt) => ({content: `reply: ${prompt}`, sessionId: 's1'});

	// createMockApp() gives the vault (basePath + exists on the adapter); extend it
	// with the adapter methods downloadAttachments() actually calls (mkdir,
	// writeBinary) and the workspace stub that keeps getSynapseView() leafless —
	// models then resolve to [] and resolveModelForAgent() to undefined, which is
	// exactly what an unconfigured bot sees.
	const {vault} = createMockApp(VAULT_BASE);
	const adapter = vault.adapter as {
		basePath: string;
		exists: (path: string) => Promise<boolean>;
		mkdir: (path: string) => Promise<void>;
		writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
	};
	const written: Array<{path: string; data: ArrayBuffer}> = [];
	const mkdirCalls: string[] = [];
	const knownDirs = new Set<string>();
	adapter.exists = async (path: string) => knownDirs.has(normalizeMockPath(path));
	adapter.mkdir = async (path: string) => {
		mkdirCalls.push(path);
		knownDirs.add(normalizeMockPath(path));
	};
	adapter.writeBinary = async (path: string, data: ArrayBuffer) => {
		written.push({path, data});
	};
	const mockApp = {
		vault,
		workspace: {
			getLeavesOfType: () => [],
		},
	} as unknown as App;

	const mockPlugin = {
		settings: {
			telegramAllowedUsers: opts?.allowedUsers ?? '111',
			featureAgents: {telegram: ''},
			telegramDefaultAgent: '',
			reasoningEffort: '',
			providerRequestTimeout: 0,
		},
		agentService: {
			inlineChat: async (options: InlineChatCall) => {
				inlineChatCalls.push({
					prompt: options.prompt,
					profile: options.profile,
					resume: options.resume,
					timeoutMs: options.timeoutMs,
					abortController: options.abortController,
				});
				// Gates park this reply until the test releases the match — how the
				// tests observe in-flight processing deterministically. Only the
				// first matching call takes the gate, so use distinct match strings.
				const gate = gates.find(g => options.prompt.includes(g.match));
				if (gate && !gate.released && !gate.taken) {
					gate.taken = true;
					await new Promise<void>(resolve => {
						gate.resolve = resolve;
					});
				}
				return makeReply(options.prompt);
			},
		},
		app: mockApp,
	} as unknown as SynapsePlugin;

	const bot = opts?.defaultFactory
		? new TelegramBotService(mockPlugin)
		: new TelegramBotService(mockPlugin, token => {
			factoryTokens.push(token);
			return fake;
		});
	bot.onStatusChange(s => statuses.push(s));

	function gate(match: string): void {
		gates.push({match, released: false, taken: false});
	}

	function releaseGate(match: string): void {
		for (const g of gates) {
			if (g.match === match) {
				g.released = true;
				g.resolve?.();
			}
		}
	}

	function releaseAllGates(): void {
		for (const g of gates) {
			g.released = true;
			g.resolve?.();
		}
	}

	function send(msg: TelegramMessage): void {
		fake.pushUpdates([{update_id: nextUpdateId++, message: msg}]);
	}

	async function stop(): Promise<void> {
		// Release gated inlineChats first so parked continuations can finish their
		// replies while the api is still connected, then disconnect and drain the
		// parked poll/typing timers so no loop leaks into the next test.
		releaseAllGates();
		await flush();
		bot.disconnect();
		fake.pushUpdates([]);
		await vi.advanceTimersByTimeAsync(TYPING_INTERVAL + 1);
		await flush();
	}

	const harness: Harness = {
		bot,
		fake,
		sentMessages: fake.sentMessages,
		factoryTokens,
		statuses,
		inlineChatCalls,
		written,
		mkdirCalls,
		gate,
		releaseGate,
		onReply: make => {
			makeReply = make;
		},
		send,
		stop,
	};
	currentHarness = harness;
	return harness;
}

/** Connect the bot and let the poll loop issue its first long-poll. */
async function connectBot(h: Harness): Promise<void> {
	await h.bot.connect('TEST_TOKEN');
	await flush();
}

const mockedRequestUrl = vi.mocked(requestUrl);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	// Teardown must run even when an assertion failed mid-test (see stop()).
	if (currentHarness) {
		await currentHarness.stop();
		currentHarness = null;
	}
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// connect() — gating, status flow, teardown
// ---------------------------------------------------------------------------

describe('TelegramBotService.connect', () => {
	it('refuses to connect when no allowed user is configured', async () => {
		const h = makeHarness({allowedUsers: '   '});
		await expect(h.bot.connect('TEST_TOKEN')).rejects.toThrow('Please add at least one allowed user ID before connecting.');
		expect(h.bot.status).toBe('disconnected');
		// The gate fires before the adapter is ever built.
		expect(h.factoryTokens).toEqual([]);
		expect(h.fake.getMeCalls).toBe(0);
		expect(h.statuses).toEqual(['connecting', 'disconnected']);
	});

	it('connects: the factory receives the token, status flows connecting→connected, polling starts', async () => {
		const h = makeHarness();
		await connectBot(h);
		expect(h.factoryTokens).toEqual(['TEST_TOKEN']);
		expect(h.bot.status).toBe('connected');
		expect(h.bot.botUsername).toBe('synapse_test_bot');
		expect(h.bot.isConnected()).toBe(true);
		expect(h.statuses).toEqual(['connecting', 'connected']);
		expect(h.fake.getMeCalls).toBe(1);
		// The first long-poll was issued with the bot's initial offset — polling is live.
		expect(h.fake.getUpdatesCalls).toEqual([{offset: 0, timeout: 30}]);
	});

	it('rethrows a getMe failure with its description, sets status error, and clears the api', async () => {
		const h = makeHarness();
		h.fake.getMeError = new TelegramApiError(401, 'Unauthorized');
		await expect(h.bot.connect('TEST_TOKEN')).rejects.toThrow('Unauthorized');
		expect(h.bot.status).toBe('error');
		expect(h.statuses).toEqual(['connecting', 'error']);
		// api cleared — the private field is the only direct way to observe the
		// clear (sendReply no-ops on a null api); a narrow cast is justified here.
		expect((h.bot as unknown as {api: unknown}).api).toBeNull();
		expect(h.fake.getUpdatesCalls).toEqual([]);
		expect(h.bot.isConnected()).toBe(false);
	});

	it('disconnect clears the status, username, and api', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.bot.disconnect();
		expect(h.bot.status).toBe('disconnected');
		expect(h.bot.isConnected()).toBe(false);
		expect(h.bot.botUsername).toBe('');
		expect((h.bot as unknown as {api: unknown}).api).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The default factory (bonus, mocked transport) — proves AC-1's "production
// call sites unchanged": with no factory passed, the bot still builds the real
// TelegramApi and reaches the Bot API through Obsidian's requestUrl. The mock
// answers {ok: undefined}, which the client maps to TelegramApiError — the
// error-mapping path connect() relies on. No network assertions beyond the URL.
// ---------------------------------------------------------------------------

describe('TelegramBotService default factory (real TelegramApi, mocked transport)', () => {
	it('constructs the real client and maps a non-ok Bot API response to an error', async () => {
		const h = makeHarness({defaultFactory: true});
		await expect(h.bot.connect('TEST_TOKEN')).rejects.toThrow('Unknown error');
		expect(h.bot.status).toBe('error');
		expect(mockedRequestUrl).toHaveBeenCalledWith(expect.objectContaining({
			url: 'https://api.telegram.org/botTEST_TOKEN/getMe',
		}));
	});
});

// ---------------------------------------------------------------------------
// Allowlist and message gating
// ---------------------------------------------------------------------------

describe('TelegramBotService allowlist', () => {
	it('processes a message from an allowed user and replies to the same chat', async () => {
		const h = makeHarness();
		await connectBot(h);
		const msg = userMessage({senderId: 111, text: 'hello there'});
		h.send(msg);
		await flush();
		expect(h.inlineChatCalls).toHaveLength(1);
		expect(h.inlineChatCalls[0]?.prompt).toContain('hello there');
		expect(h.inlineChatCalls[0]?.prompt).toContain('Working directory: C:/mock-vault');
		// The documented bot policy (specs/bots.md) — asserted to catch silent drift.
		expect(h.inlineChatCalls[0]?.profile).toBe('unattendedBypass');
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.chat_id).toBe(100);
		expect(h.sentMessages[0]?.reply_to_message_id).toBe(msg.message_id);
	});

	it('silently drops messages from users not on the allowlist', async () => {
		const h = makeHarness({allowedUsers: '111'});
		await connectBot(h);
		h.send(userMessage({senderId: 999, text: 'sneaky'}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(0);
		expect(h.sentMessages).toHaveLength(0);
	});

	it('parses allowlist ids with surrounding whitespace', async () => {
		const h = makeHarness({allowedUsers: ' 111 , 222 '});
		await connectBot(h);
		h.send(userMessage({senderId: 222, text: 'from the second user'}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(1);
		expect(h.inlineChatCalls[0]?.prompt).toContain('from the second user');
	});

	it('ignores messages with no usable content (no text, caption, or media)', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.send(userMessage({text: undefined}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(0);
		expect(h.sentMessages).toHaveLength(0);
	});

	it('drops messages with no sender at all', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.send(userMessage({from: undefined}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(0);
		expect(h.sentMessages).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

describe('TelegramBotService commands', () => {
	it('/start answers with the canned greeting and never calls inlineChat', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.send(userMessage({text: '/start'}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(0);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.text).toContain("I'm your Synapse assistant");
	});

	it('/help answers with the canned usage text and never calls inlineChat', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.send(userMessage({text: '/help'}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(0);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.text).toContain('Send me any text message to chat');
	});

	it('/new aborts the in-flight controller, clears the session, and the next message starts fresh', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.gate('hold this');
		h.send(userMessage({text: 'hold this'}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(1);

		// While the first message is still in flight, /new resets its session.
		h.send(userMessage({text: '/new'}));
		await flush();
		expect(h.inlineChatCalls[0]?.abortController?.signal.aborted).toBe(true);
		expect(h.sentMessages[0]?.text).toBe('Session reset. Send a new message to start fresh.');

		// The next message gets a brand-new session — no resume of the aborted one.
		h.releaseGate('hold this');
		h.send(userMessage({text: 'fresh start'}));
		await flush();
		expect(h.inlineChatCalls).toHaveLength(2);
		expect(h.inlineChatCalls[1]?.prompt).toContain('fresh start');
		expect(h.inlineChatCalls[1]?.resume).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Per-chat/topic queue serialization
// ---------------------------------------------------------------------------

describe('TelegramBotService queue serialization', () => {
	it('runs two messages on one chat/topic sequentially — the second starts only after the first finishes', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.gate('msg one');
		h.send(userMessage({threadId: 7, text: 'msg one'}));
		h.send(userMessage({threadId: 7, text: 'msg two'}));
		await flush();
		// The second message is queued behind the gated first — it hasn't started.
		expect(h.inlineChatCalls).toHaveLength(1);
		expect(h.inlineChatCalls[0]?.prompt).toContain('msg one');

		h.releaseGate('msg one');
		await flush();
		expect(h.inlineChatCalls).toHaveLength(2);
		expect(h.inlineChatCalls[1]?.prompt).toContain('msg two');
		// The first reply was already sent before the second inlineChat started —
		// recorded order is the serialization proof.
		expect(h.sentMessages).toHaveLength(2);
		expect(h.sentMessages[0]?.text).toContain('msg one');
		expect(h.sentMessages[1]?.text).toContain('msg two');
	});

	it('messages on different chats do not block each other', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.gate('first message');
		h.send(userMessage({text: 'first message'}));
		h.send(userMessage({chatId: 200, text: 'second chat'}));
		await flush();
		// Chat 200's message completed while chat 100's is still gated in flight.
		expect(h.inlineChatCalls).toHaveLength(2);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.chat_id).toBe(200);
		expect(h.sentMessages[0]?.text).toContain('second chat');

		h.releaseGate('first message');
		await flush();
		expect(h.sentMessages).toHaveLength(2);
		expect(h.sentMessages[1]?.chat_id).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// Reply delivery — splitting at Telegram's 4096 limit, and the "can't parse"
// retry-as-plain-text path.
// ---------------------------------------------------------------------------

describe('TelegramBotService reply splitting', () => {
	it('splits at a newline near the 4096 limit, replying-to only the first chunk', async () => {
		const h = makeHarness();
		await connectBot(h);
		const msg = userMessage({text: 'give me the long text'});
		h.onReply(() => ({content: 'x'.repeat(3000) + '\n' + 'y'.repeat(2000), sessionId: 's1'}));
		h.send(msg);
		await flush();
		expect(h.sentMessages).toHaveLength(2);
		expect(h.sentMessages[0]?.text).toMatch(/^x+$/);
		expect(h.sentMessages[0]?.text?.length).toBe(3000);
		expect(h.sentMessages[1]?.text).toMatch(/^y+$/);
		expect(h.sentMessages[1]?.text?.length).toBe(2000);
		expect(h.sentMessages[0]?.reply_to_message_id).toBe(msg.message_id);
		expect(h.sentMessages[1]?.reply_to_message_id).toBeUndefined();
	});

	it('falls back to a space when no newline is near the limit', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.onReply(() => ({content: 'a'.repeat(3000) + ' ' + 'b'.repeat(2000), sessionId: 's1'}));
		h.send(userMessage());
		await flush();
		expect(h.sentMessages).toHaveLength(2);
		expect(h.sentMessages[0]?.text).toMatch(/^a+$/);
		expect(h.sentMessages[0]?.text?.length).toBe(3000);
		expect(h.sentMessages[1]?.text).toMatch(/^b+$/);
		expect(h.sentMessages[1]?.text?.length).toBe(2000);
	});

	it('hard-splits at exactly 4096 when neither newline nor space is near the limit', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.onReply(() => ({content: 'c'.repeat(5000), sessionId: 's1'}));
		h.send(userMessage());
		await flush();
		expect(h.sentMessages).toHaveLength(2);
		expect(h.sentMessages[0]?.text).toMatch(/^c+$/);
		expect(h.sentMessages[0]?.text?.length).toBe(TG_MAX_LENGTH);
		expect(h.sentMessages[1]?.text).toMatch(/^c+$/);
		expect(h.sentMessages[1]?.text?.length).toBe(5000 - TG_MAX_LENGTH);
	});

	it('sends a single message at exactly the 4096 limit', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.onReply(() => ({content: 'd'.repeat(TG_MAX_LENGTH), sessionId: 's1'}));
		h.send(userMessage());
		await flush();
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.text?.length).toBe(TG_MAX_LENGTH);
	});
});

describe('TelegramBotService reply error handling', () => {
	it('retries a chunk as a second sendMessage when Telegram reports a parse failure', async () => {
		const h = makeHarness();
		await connectBot(h);
		const msg = userMessage({text: 'hello'});
		h.onReply(() => ({content: 'mock reply', sessionId: 's1'}));
		h.fake.queuedSendMessageErrors.push(new TelegramApiError(400, "Bad Request: can't parse entities"));
		h.send(msg);
		await flush();
		// The failed attempt plus the plain-text retry — the retry path was taken.
		expect(h.fake.sendMessageAttempts).toBe(2);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.text).toBe('mock reply');
		expect(h.sentMessages[0]?.chat_id).toBe(100);
		expect(h.sentMessages[0]?.reply_to_message_id).toBe(msg.message_id);
	});

	it('replies with the error text when a non-parse error escapes sendReply', async () => {
		const h = makeHarness();
		await connectBot(h);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		h.onReply(() => ({content: 'mock reply', sessionId: 's1'}));
		h.fake.queuedSendMessageErrors.push(new Error('network down'));
		h.send(userMessage({text: 'hello'}));
		await flush();
		// Attempt 1 threw (not "can't parse" → rethrown), then the catch sent the
		// error reply as attempt 2.
		expect(h.fake.sendMessageAttempts).toBe(2);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.text).toBe('Error: network down');
		errorSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Typing indicator — sent while processing, loop halts afterwards.
// ---------------------------------------------------------------------------

describe('TelegramBotService typing loop', () => {
	it('sends typing actions while processing and stops once the message completes', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.gate('hold this');
		h.send(userMessage({text: 'hold this'}));
		await flush();
		// First action fires as soon as processing starts.
		expect(h.fake.chatActions.length).toBeGreaterThanOrEqual(1);
		expect(h.fake.chatActions[0]).toEqual({chat_id: 100, action: 'typing'});
		const duringHold = h.fake.chatActions.length;

		// The loop refreshes on every interval while the reply is still in flight.
		await vi.advanceTimersByTimeAsync(TYPING_INTERVAL * 2);
		expect(h.fake.chatActions.length).toBe(duringHold + 2);

		// Completing the message stops the loop — no further actions, ever.
		h.releaseGate('hold this');
		await flush();
		const afterStop = h.fake.chatActions.length;
		await vi.advanceTimersByTimeAsync(TYPING_INTERVAL * 2 + 1);
		expect(h.fake.chatActions.length).toBe(afterStop);
	});
});

// ---------------------------------------------------------------------------
// Attachments — largest photo, filename sanitization, adapter write, prompt inlining.
// ---------------------------------------------------------------------------

describe('TelegramBotService attachments', () => {
	it('downloads the largest photo resolution and inlines the saved path into the prompt', async () => {
		const h = makeHarness();
		await connectBot(h);
		const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
		h.fake.fileResponses['big'] = {file_id: 'big', file_unique_id: 'b1', file_path: 'photos/big.jpg'};
		h.fake.downloadResponses['photos/big.jpg'] = bytes;
		const msg = userMessage({
			text: 'what is in this photo?',
			photo: [
				{file_id: 'small', file_unique_id: 's1', width: 90, height: 90},
				{file_id: 'mid', file_unique_id: 'm1', width: 320, height: 320},
				{file_id: 'big', file_unique_id: 'b1', width: 1280, height: 1280},
			],
		});
		h.send(msg);
		await flush();
		// Only the largest resolution is requested (photo array is ordered small→large).
		expect(h.fake.getFileCalls).toEqual(['big']);
		expect(h.fake.downloadCalls).toEqual(['photos/big.jpg']);
		// Saved via the vault adapter under _synapse/bot-attachments/.
		expect(h.mkdirCalls).toEqual(['_synapse/bot-attachments']);
		const writtenPath = h.written[0]?.path ?? '';
		expect(writtenPath).toMatch(new RegExp(`^_synapse/bot-attachments/\\d+_photo_${msg.message_id}\\.jpg$`));
		expect(h.written[0]?.data).toBe(bytes);
		// The absolute path is inlined into the prompt (the SDK has no attachments
		// field — a real path the model can Read is the transport).
		expect(h.inlineChatCalls).toHaveLength(1);
		expect(h.inlineChatCalls[0]?.prompt).toContain('what is in this photo?');
		expect(h.inlineChatCalls[0]?.prompt).toContain(`Attached file: photo_${msg.message_id}.jpg`);
		expect(h.inlineChatCalls[0]?.prompt).toContain(`Path: ${VAULT_BASE}/${writtenPath}`);
	});

	it('sanitizes document filenames before writing them to the vault', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.send(userMessage({
			text: '',
			document: {file_id: 'doc', file_unique_id: 'd1', file_name: 'bad name!.txt'},
		}));
		await flush();
		expect(h.fake.getFileCalls).toEqual(['doc']);
		const writtenPath = h.written[0]?.path ?? '';
		// [^a-zA-Z0-9._-] → '_' — 'bad name!.txt' becomes 'bad_name_.txt'.
		expect(writtenPath).toMatch(/^_synapse\/bot-attachments\/\d+_bad_name_\.txt$/);
		expect(h.inlineChatCalls[0]?.prompt).toContain('Attached file: bad_name_.txt');
		expect(h.inlineChatCalls[0]?.prompt).toContain(`Path: ${VAULT_BASE}/${writtenPath}`);
	});
});

// ---------------------------------------------------------------------------
// Session identity — resume on the same chat, fresh for a different chat.
// ---------------------------------------------------------------------------

describe('TelegramBotService session identity', () => {
	it('resumes the sessionId on the second message of the same chat, not for a different chat', async () => {
		const h = makeHarness();
		await connectBot(h);
		h.send(userMessage({text: 'first question'}));
		await flush();
		expect(h.inlineChatCalls[0]?.resume).toBeUndefined();

		h.send(userMessage({text: 'second question'}));
		await flush();
		expect(h.inlineChatCalls[1]?.resume).toBe('s1');

		h.send(userMessage({chatId: 200, text: 'other chat'}));
		await flush();
		expect(h.inlineChatCalls[2]?.prompt).toContain('other chat');
		expect(h.inlineChatCalls[2]?.resume).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Poll loop resilience — back off ~5s after a poll error, then retry (fake
// timers: no test waits on the real backoff).
// ---------------------------------------------------------------------------

describe('TelegramBotService poll loop resilience', () => {
	it('backs off ~5s after a poll error and retries without dying', async () => {
		const h = makeHarness();
		await connectBot(h);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		h.fake.failPendingPoll(new Error('poll boom'));
		await flush();

		// Still inside the backoff — advancing just under 5s must not retry.
		await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS - 1);
		await flush();
		expect(h.fake.getUpdatesCalls).toHaveLength(1);

		// Crossing the 5s boundary retries the poll; the bot stays connected.
		await vi.advanceTimersByTimeAsync(2);
		await flush();
		expect(h.fake.getUpdatesCalls).toHaveLength(2);
		expect(h.bot.status).toBe('connected');
		errorSpy.mockRestore();
	});
});