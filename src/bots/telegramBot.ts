/**
 * Telegram Bot service — handles long-polling, message routing,
 * topic-based session management, file attachments, and replying.
 */

import {normalizePath, Notice} from 'obsidian';
import type SynapsePlugin from '../main';
import type {SynapseView} from '../synapseView';
import {SYNAPSE_VIEW_TYPE} from '../synapseView';
import type {SessionConfig} from '../agentService';
// Session import removed — bot uses inlineChat directly
import type {AgentConfig, SkillInfo} from '../types';
import {SYNAPSE_FOLDER, getVaultBasePath, getSynapsePluginConfig} from '../vaultPaths';
import {scanAgents, scanSkills} from '../configWriter';
import {buildCurrentAgentLine, buildResilienceHint, buildSelfImproveHint, getAdaptiveTimeout} from '../view/sessionConfig';
import {resolveModelForAgent} from '../view/sessionConfig';
import type {TelegramMessage} from './telegramApi';
import {TelegramApi, TelegramApiError} from './telegramApi';
import type {BotConnectionStatus} from './types';

/** Key for a topic-based session: "chatId" or "chatId:threadId". */
function sessionKey(chatId: number, threadId?: number): string {
	return threadId != null ? `${chatId}:${threadId}` : `${chatId}`;
}

/** Maximum response length per Telegram message (4096 chars). */
const TG_MAX_LENGTH = 4096;

/** Typing indicator interval (5s, Telegram recommends refreshing). */
const TYPING_INTERVAL = 5000;

interface ActiveBotSession {
	sessionId: string;
	lastActivity: number;
	/** Serializes message processing — each message waits for the previous one. */
	queue: Promise<void>;
	abortController?: AbortController | null;
}

/**
 * Manages a Telegram bot connection including polling, session routing,
 * and message processing.
 */
export class TelegramBotService {
	private api: TelegramApi | null = null;
	private polling = false;
	private pollAbort: AbortController | null = null;
	private offset = 0;
	status: BotConnectionStatus = 'disconnected';
	botUsername = '';

	/** Active Synapse sessions keyed by chat:thread. */
	private sessions = new Map<string, ActiveBotSession>();

	/** Cached agent/skill configs (reloaded on connect). */
	private agents: AgentConfig[] = [];
	private skills: SkillInfo[] = [];

	/** Status change callbacks. */
	private statusListeners: Array<(status: BotConnectionStatus) => void> = [];

	constructor(private plugin: SynapsePlugin) {}

	onStatusChange(cb: (status: BotConnectionStatus) => void): () => void {
		this.statusListeners.push(cb);
		return () => {
			this.statusListeners = this.statusListeners.filter(l => l !== cb);
		};
	}

	private setStatus(status: BotConnectionStatus): void {
		this.status = status;
		for (const cb of this.statusListeners) cb(status);
	}

	/** Connect to Telegram and start polling. */
	async connect(botToken: string): Promise<void> {
		if (this.polling) {
			this.disconnect();
		}
		this.setStatus('connecting');

		// Require at least one allowed user before connecting
		const allowedRaw = this.plugin.settings.telegramAllowedUsers.trim();
		if (!allowedRaw) {
			this.setStatus('disconnected');
			throw new Error('Please add at least one allowed user ID before connecting.');
		}

		this.api = new TelegramApi(botToken);

		try {
			const me = await this.api.getMe();
			this.botUsername = me.username ?? me.first_name;
			new Notice(`Telegram bot @${this.botUsername} connected.`);
		} catch (e) {
			this.api = null;
			this.setStatus('error');
			const msg = e instanceof TelegramApiError ? e.description : String(e);
			throw new Error(msg);
		}

		// Load agent/skill/tool configs for session creation
		await this.reloadConfigs();

		this.setStatus('connected');
		this.startPolling();
	}

	/** Stop polling and disconnect. */
	disconnect(): void {
		this.polling = false;
		if (this.pollAbort) {
			this.pollAbort.abort();
			this.pollAbort = null;
		}

		// Clear all sessions (abort any in-flight requests)
		for (const sess of this.sessions.values()) {
			if (sess.abortController) {
				try { sess.abortController.abort(); } catch { /* ignore */ }
				sess.abortController = null;
			}
		}
		this.sessions.clear();

		this.api = null;
		this.botUsername = '';
		this.setStatus('disconnected');
	}

	isConnected(): boolean {
		return this.status === 'connected' && this.polling;
	}

	// ── Polling ──────────────────────────────────────────────────

	private startPolling(): void {
		this.polling = true;
		void this.pollLoop();
	}

	private async pollLoop(): Promise<void> {
		while (this.polling && this.api) {
			try {
				this.pollAbort = new AbortController();
				const updates = await this.api.getUpdates(this.offset, 30);
				for (const update of updates) {
					this.offset = update.update_id + 1;
					const msg = update.message ?? update.edited_message;
					if (msg) {
						void this.handleMessage(msg);
					}
				}
			} catch (e) {
				if (!this.polling) break; // disconnect was called
				console.error('Synapse Telegram: poll error', e);
				// Back off on error
				await new Promise(r => window.setTimeout(r, 5000));
			}
		}
	}

	// ── Message handling ─────────────────────────────────────────

	private async handleMessage(msg: TelegramMessage): Promise<void> {
		const text = msg.text ?? msg.caption ?? '';
		const chatId = msg.chat.id;
		const threadId = msg.message_thread_id;

		// Check allowed users list — at least one user must be configured
		const allowedRaw = this.plugin.settings.telegramAllowedUsers.trim();
		const allowedIds = new Set(allowedRaw.split(',').map(s => s.trim()).filter(Boolean));
		const senderId = msg.from?.id?.toString();
		if (!senderId || !allowedIds.has(senderId)) {
			return; // silently ignore unauthorized users
		}

		// Ignore messages with no usable content
		if (!text && !msg.photo && !msg.document && !msg.audio && !msg.voice && !msg.video) {
			return;
		}

		// Handle /start command
		if (text === '/start') {
			await this.sendReply(chatId, threadId, `Hello! I'm your Synapse assistant. Send me a message and I'll help you.`);
			return;
		}

		// Handle /help command
		if (text === '/help') {
			await this.sendReply(chatId, threadId,
				`I'm your Obsidian Synapse bot. Here's what you can do:\n` +
				`• Send me any text message to chat\n` +
				`• Attach photos, documents, or audio\n` +
				`• Use forum topics for parallel conversations\n` +
				`• /start — Start a new conversation\n` +
				`• /new — Start a fresh session\n` +
				`• /help — Show this help`
			);
			return;
		}

		// Handle /new command — reset the session for this chat/topic
		if (text === '/new') {
			const key = sessionKey(chatId, threadId);
			const existing = this.sessions.get(key);
			if (existing?.abortController) {
				try { existing.abortController.abort(); } catch { /* ignore */ }
				existing.abortController = null;
			}
			this.sessions.delete(key);
			await this.sendReply(chatId, threadId, 'Session reset. Send a new message to start fresh.');
			return;
		}

		// Get or create session tracking entry (needed for queuing)
		const key = sessionKey(chatId, threadId);
		let entry = this.sessions.get(key);
		if (!entry) {
			entry = {
				sessionId: '', // will be set on first processMessage
				lastActivity: Date.now(),
				queue: Promise.resolve(),
			};
			this.sessions.set(key, entry);
		}

		// Queue this message so we serialize per chat/topic.
		const currentEntry = entry;
		entry.queue = entry.queue.then(() => this.processMessage(currentEntry, msg)).catch(() => {});
	}

	/** Process a single message within a serialized queue. */
	private async processMessage(entry: ActiveBotSession, msg: TelegramMessage): Promise<void> {
		const text = msg.text ?? msg.caption ?? '';
		const chatId = msg.chat.id;
		const threadId = msg.message_thread_id;

		// Send typing indicator
		const stopTyping = this.sendTypingLoop(chatId, threadId);

		try {
			entry.lastActivity = Date.now();
			entry.abortController = new AbortController();

			// Download attachments if any, and inline their absolute paths into the prompt.
			// query()'s Options has no top-level `attachments` field — the Agent SDK only
			// accepts `prompt: string | AsyncIterable<SDKUserMessage>` — so a real path the
			// model can Read itself is the only way the content actually reaches it (same
			// mechanism as the chat view's buildPrompt()).
			const attachmentPaths = await this.downloadAttachments(msg);
			let promptText = text || '(attachment)';
			for (const att of attachmentPaths) {
				promptText += `\n\n---\nAttached file: ${att.name}\nPath: ${att.path}`;
			}

			// Per-turn volatile context (issue #201) — Working directory and the current agent
			// stay out of `systemPrompt.append` (built in `buildBotSessionConfig()`) and are
			// delivered here instead, matching the chat view's split.
			const normalizedBasePath = this.getVaultBasePath().replace(/\\/g, '/');
			const defaultAgentName = this.plugin.settings.featureAgents?.telegram || this.plugin.settings.telegramDefaultAgent || undefined;
			promptText += `\n\nWorking directory: ${normalizedBasePath}` + buildCurrentAgentLine(defaultAgentName || 'Auto');

			const sendOpts = {
				prompt: promptText,
			};

			// Create a fresh session for each message. If we have a previous sessionId,
			// resume it to maintain conversation history. This avoids all shared-state
			// issues with the chat view's resumeSession taking over event listeners.
			const config = this.buildBotSessionConfig();
			const timeoutMs = getAdaptiveTimeout(this.plugin.app, undefined, this.plugin.settings.providerRequestTimeout);

			// Use inlineChat which handles session resume internally
			const {content, sessionId} = await this.plugin.agentService!.inlineChat({
				prompt: sendOpts.prompt,
				app: this.plugin.app,
				// Bot sessions run bypassPermissions unconditionally (see the comment in
				// buildBotSessionConfig() below for why this must not track settings.toolApproval).
				profile: 'unattendedBypass',
				...(entry.sessionId ? {resume: entry.sessionId} : {}),
				...config,
				timeoutMs,
				abortController: entry.abortController,
			});
			if (sessionId) {
				entry.sessionId = sessionId;
			}

			if (content) {
				await this.sendReply(chatId, threadId, content, msg.message_id);
			}

		} catch (e) {
			console.error('Synapse Telegram: message handling error', e);
			// If session is broken, clear it so next message creates a fresh one
			if (String(e).includes('Session not found')) {
				entry.sessionId = '';
			}
			const errorText = e instanceof Error ? e.message : String(e);
			await this.sendReply(chatId, threadId, `Error: ${errorText}`);
		} finally {
			entry.abortController = null;
			stopTyping();
		}
	}

	// ── Session creation ─────────────────────────────────────────

	private buildBotSessionConfig(): SessionConfig {
		const basePath = this.getVaultBasePath();
		const defaultAgentName = this.plugin.settings.featureAgents?.telegram || this.plugin.settings.telegramDefaultAgent || undefined;

		// Resolve agent
		const agent = defaultAgentName
			? this.agents.find(a => a.name === defaultAgentName)
			: undefined;

		// Model
		const models = this.getAvailableModels();
		const model = resolveModelForAgent(agent, models, undefined);

		const reasoningEffort = this.plugin.settings.reasoningEffort;
		const normalizedBasePath = basePath.replace(/\\/g, '/');
		// Session-stable content only (issue #201) — Working directory and the current agent
		// are volatile in general (they can change between turns of a resumed conversation)
		// and are delivered per-turn in the prompt instead (see `processMessage()`), matching
		// the chat view's split even though this bot's own values happen to be constant across
		// a chat/topic today. Resilience guidance (constraint: bot runs unattended, bypassing
		// permissions, so it must never silently lose this) stays here, unconditionally stable.
		const systemContent = [
			'[Workspace Path Information]',
			`Vault root: ${normalizedBasePath}`,
		].join('\n') + buildResilienceHint() + buildSelfImproveHint();

		return {
			model,
			// Bot sessions run bypassPermissions unconditionally — deliberately NOT
			// driven by settings.toolApproval (issue #151). Threading toolApproval
			// through here would make remote-control-a-vault-from-your-phone (the bot's
			// entire purpose) silently stop writing the moment someone sets the global
			// setting to "ask" for an unrelated reason (e.g. wanting search/editor
			// actions to prompt), with no per-message equivalent of a trigger's
			// toolApproval: allow opt-in to recover with. The bot's real safety control is the numeric allowlist gating who can
			// reach it at all (connect()/handleMessage() below) — see SECURITY.md #1,
			// which this doesn't change. If unattended-vs-interactive nuance is wanted for
			// the bot too, that's a follow-up with its own design (e.g. a bot-specific
			// approval setting), not a silent side effect of this issue.
			// The bypass fields themselves are set by the unattendedBypass inlineChat()
			// profile at the call site above (issue #230).
			cwd: basePath,
			plugins: getSynapsePluginConfig(this.plugin.app),
			...(reasoningEffort !== '' ? {effort: reasoningEffort as import('../agentService').ReasoningEffort} : {}),
			...(defaultAgentName ? {agent: defaultAgentName} : {}),
			// Append to the Claude Code preset — a plain string would replace the
			// default system prompt and the bot stops using tools/reading files.
			systemPrompt: {type: 'preset' as const, preset: 'claude_code' as const, append: systemContent},
		};
	}

	// ── Replies ──────────────────────────────────────────────────

	private async sendReply(chatId: number, threadId: number | undefined, text: string, replyToMessageId?: number): Promise<void> {
		if (!this.api) return;

		// Split long messages (Telegram max 4096 chars)
		const chunks = this.splitMessage(text);
		for (const chunk of chunks) {
			try {
				await this.api.sendMessage({
					chat_id: chatId,
					text: chunk,
					...(threadId != null ? {message_thread_id: threadId} : {}),
					...(replyToMessageId != null ? {reply_to_message_id: replyToMessageId} : {}),
				});
			} catch (e) {
				// If markdown parsing fails, retry as plain text
				if (e instanceof TelegramApiError && e.description.includes("can't parse")) {
					await this.api.sendMessage({
						chat_id: chatId,
						text: chunk,
						...(threadId != null ? {message_thread_id: threadId} : {}),
						...(replyToMessageId != null ? {reply_to_message_id: replyToMessageId} : {}),
					});
				} else {
					throw e;
				}
			}
			// Only reply-to the first chunk
			replyToMessageId = undefined;
		}
	}

	private splitMessage(text: string): string[] {
		if (text.length <= TG_MAX_LENGTH) return [text];

		const chunks: string[] = [];
		let remaining = text;
		while (remaining.length > 0) {
			if (remaining.length <= TG_MAX_LENGTH) {
				chunks.push(remaining);
				break;
			}
			// Try to split at a newline near the limit
			let splitAt = remaining.lastIndexOf('\n', TG_MAX_LENGTH);
			if (splitAt < TG_MAX_LENGTH / 2) {
				// No good newline, try space
				splitAt = remaining.lastIndexOf(' ', TG_MAX_LENGTH);
			}
			if (splitAt < TG_MAX_LENGTH / 2) {
				splitAt = TG_MAX_LENGTH;
			}
			chunks.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt).trimStart();
		}
		return chunks;
	}

	/** Send typing indicator in a loop until the returned stop function is called. */
	private sendTypingLoop(chatId: number, threadId: number | undefined): () => void {
		let running = true;
		const loop = async () => {
			while (running && this.api) {
				try {
					await this.api.sendChatAction({
						chat_id: chatId,
						action: 'typing',
						...(threadId != null ? {message_thread_id: threadId} : {}),
					});
				} catch { /* ignore */ }
				await new Promise(r => window.setTimeout(r, TYPING_INTERVAL));
			}
		};
		void loop();
		return () => { running = false; };
	}

	// ── Attachments ──────────────────────────────────────────────

	private async downloadAttachments(msg: TelegramMessage): Promise<Array<{name: string; path: string}>> {
		if (!this.api) return [];

		const results: Array<{name: string; path: string}> = [];
		const filesToDownload: Array<{fileId: string; name: string}> = [];

		// Photos — pick the largest resolution
		if (msg.photo && msg.photo.length > 0) {
			const largest = msg.photo[msg.photo.length - 1]!;
			filesToDownload.push({fileId: largest.file_id, name: `photo_${msg.message_id}.jpg`});
		}

		if (msg.document) {
			filesToDownload.push({fileId: msg.document.file_id, name: msg.document.file_name ?? `doc_${msg.message_id}`});
		}

		if (msg.audio) {
			filesToDownload.push({fileId: msg.audio.file_id, name: msg.audio.file_name ?? `audio_${msg.message_id}.mp3`});
		}

		if (msg.voice) {
			filesToDownload.push({fileId: msg.voice.file_id, name: `voice_${msg.message_id}.ogg`});
		}

		if (msg.video) {
			filesToDownload.push({fileId: msg.video.file_id, name: msg.video.file_name ?? `video_${msg.message_id}.mp4`});
		}

		for (const file of filesToDownload) {
			try {
				const fileInfo = await this.api.getFile(file.fileId);
				if (!fileInfo.file_path) continue;

				const data = await this.api.downloadFile(fileInfo.file_path);

				// Save to temp location in vault
				const tempDir = normalizePath(`${SYNAPSE_FOLDER}/bot-attachments`);
				const adapter = this.plugin.app.vault.adapter;
				if (!await adapter.exists(tempDir)) {
					await adapter.mkdir(tempDir);
				}

				// Sanitize filename
				const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
				const filePath = normalizePath(`${tempDir}/${Date.now()}_${safeName}`);
				await adapter.writeBinary(filePath, data);

				const basePath = this.getVaultBasePath();
				results.push({name: safeName, path: `${basePath}/${filePath}`});
			} catch (e) {
				console.error(`Synapse Telegram: failed to download file ${file.name}`, e);
			}
		}

		return results;
	}

	// ── Helpers ──────────────────────────────────────────────────

	private getSynapseView(): SynapseView | null {
		const leaves = this.plugin.app.workspace.getLeavesOfType(SYNAPSE_VIEW_TYPE);
		if (leaves.length > 0 && leaves[0]) {
			return leaves[0].view as SynapseView;
		}
		return null;
	}

	private getVaultBasePath(): string {
		return getVaultBasePath(this.plugin.app);
	}

	private getAvailableModels(): import('../agentService').ModelInfo[] {
		const view = this.getSynapseView();
		return view?.models ?? [];
	}

	async reloadConfigs(): Promise<void> {
		try {
			const app = this.plugin.app;
			const [agents, skills] = await Promise.all([
				scanAgents(app, normalizePath(`${SYNAPSE_FOLDER}/agents`)),
				scanSkills(app, normalizePath(`${SYNAPSE_FOLDER}/skills`)),
			]);
			this.agents = agents;
			this.skills = skills;
		} catch (e) {
			console.error('Synapse Telegram: failed to reload configs', e);
		}
	}
}
