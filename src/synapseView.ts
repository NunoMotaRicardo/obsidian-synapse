import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	TFile,
	normalizePath,
	setIcon,
	Component,
} from 'obsidian';
import SynapsePlugin, {SYNAPSE_ICON_ID} from './main';
import type {
	SessionConfig,
	ModelInfo,
	ReasoningEffort,
	SessionEvent,
} from './copilot';
import {Session} from './copilot';
import type {AgentConfig, SkillInfo, TriggerConfig, ChatMessage, ChatAttachment} from './types';
import {scanAgents, scanSkills, scanTriggers} from './configWriter';
import {SYNAPSE_FOLDER} from './settings';
import {debugTrace} from './debug';
import {ToolApprovalModal} from './modals/toolApprovalModal';
// UserInputModal removed — Agent SDK handles user input via hooks
import {ElicitationModal} from './modals/elicitationModal';
import type {BackgroundSession} from './view/types';

/** Frozen sentinel — when earlyEventBuffer points here, onEvent stops buffering. */
const EMPTY_EVENT_BUFFER: readonly SessionEvent[] = Object.freeze([]);
import {buildPrompt, buildSdkAttachments, buildSelfImproveHint, buildVaultContextBlock, resolveNoteImageEmbeds} from './view/sessionConfig';

export const SYNAPSE_VIEW_TYPE = 'synapse-view';

// ── Synapse view ───────────────────────────────────────────────

export class SynapseView extends ItemView {
	plugin: SynapsePlugin;

	// ── State ────────────────────────────────────────────────────
	// Properties are non-private to allow access from view extension modules (src/view/).
	messages: ChatMessage[] = [];
	currentSession: Session | null = null;
	agents: AgentConfig[] = [];
	models: ModelInfo[] = [];
	skills: SkillInfo[] = [];
	triggers: TriggerConfig[] = [];

	selectedAgent = '';
	selectedModel = '';
	enabledSkills: Set<string> = new Set();
	attachments: ChatAttachment[] = [];
	activeNotePath: string | null = null;
	activeSelection: {filePath: string; fileName: string; text: string; startLine: number; startChar: number; endLine: number; endChar: number} | null = null;
	selectionPollTimer: ReturnType<typeof setInterval> | null = null;
	editorHadFocus = false;
	cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null = null;
	scopePaths: string[] = [];
	workingDir = '';

	isStreaming = false;
	configDirty = true;
	streamingContent = '';
	renderScheduled = false;
	showDebugInfo = false;
	lastFullRenderLen = 0;
	fullRenderTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Reasoning streaming state ──────────────────────────────
	streamingReasoning = '';
	reasoningEl: HTMLDetailsElement | null = null;
	reasoningBodyEl: HTMLElement | null = null;
	reasoningComplete = false;
	fullReasoningRenderTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Turn-level metadata ────────────────────────────────────
	turnStartTime = 0;
	turnToolsUsed: string[] = [];
	turnSkillsUsed: string[] = [];
	turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null = null;
	activeToolCalls = new Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>();

	// ── Session sidebar state ──────────────────────────────────
	activeSessions = new Map<string, BackgroundSession>();
	sessionList: import('./copilot').SessionMetadata[] = [];
	sessionNames: Record<string, string> = {};
	currentSessionId: string | null = null;
	sidebarWidth = 40;
	sessionFilter = '';
	sessionTypeFilter = new Set<'chat' | 'inline' | 'search' | 'other'>(['chat']);
	sessionSort: 'modified' | 'created' | 'name' = 'modified';

	// ── Tab state ────────────────────────────────────────────────
	activeTab: 'chat' | 'search' = 'chat';

	// ── Search panel state ───────────────────────────────────────
	searchAgent = '';
	searchModel = '';
	searchWorkingDir = '';
	searchEnabledSkills: Set<string> = new Set();
	searchAgentSelect!: HTMLSelectElement;
	searchModelSelect!: HTMLSelectElement;
	searchSkillsBtnEl!: HTMLButtonElement;
	searchToolsBtnEl!: HTMLButtonElement;
	searchCwdBtnEl!: HTMLButtonElement;
	searchInputEl!: HTMLTextAreaElement;
	searchBtnEl!: HTMLButtonElement;
	searchResultsEl!: HTMLElement;
	searchSession: Session | null = null;
	isSearching = false;
	searchModeToggleEl!: HTMLButtonElement;
	searchAdvancedToolbarEl!: HTMLElement;
	basicSearchSession: Session | null = null;

	// ── DOM refs ─────────────────────────────────────────────────
	mainEl!: HTMLElement;
	tabBarEl!: HTMLElement;
	chatPanelEl!: HTMLElement;
	searchPanelEl!: HTMLElement;
	chatContainer!: HTMLElement;
	streamingBodyEl: HTMLElement | null = null;
	toolCallsContainer: HTMLElement | null = null;
	inputEl!: HTMLTextAreaElement;
	attachmentsBar!: HTMLElement;
	activeNoteBar!: HTMLElement;
	scopeBar!: HTMLElement;
	sendBtn!: HTMLButtonElement;
	agentSelect!: HTMLSelectElement;
	modelSelect!: HTMLSelectElement;
	modelIconEl!: HTMLSpanElement;
	skillsBtnEl!: HTMLButtonElement;
	toolsBtnEl!: HTMLButtonElement;
	cwdBtnEl!: HTMLButtonElement;
	debugBtnEl!: HTMLElement;
	streamingComponent: Component | null = null;
	streamingWrapperEl: HTMLElement | null = null;

	// ── Config file watcher ──────────────────────────────────────
	configRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	configLoading = false;
	configLoadedAt = 0;

	// ── Session sidebar DOM refs ─────────────────────────────────
	sidebarEl!: HTMLElement;
	sidebarListEl!: HTMLElement;
	sidebarSearchEl!: HTMLInputElement;
	sidebarFilterEl!: HTMLButtonElement;
	sidebarSortEl!: HTMLButtonElement;
	sidebarRefreshEl!: HTMLButtonElement;
	sidebarDeleteEl!: HTMLButtonElement;
	splitterEl!: HTMLElement;

	eventUnsubscribers: (() => void)[] = [];
	earlyEventBuffer: SessionEvent[] | readonly SessionEvent[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: SynapsePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SYNAPSE_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Synapse';
	}
	getIcon(): string {
		return SYNAPSE_ICON_ID;
	}

	saveSessionNames(): void {
		this.plugin.settings.sessionNames = {...this.sessionNames};
		void this.plugin.saveSettings();
	}

	registerInlineSession(sessionId: string, description: string): void {
		this.sessionNames[sessionId] = `[inline] ${description}`;
		this.saveSessionNames();

		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				summary: '',
				lastModified: now.getTime(),
			} as import('./copilot').SessionMetadata);
		}

		if (this.sidebarListEl) {
			this.renderSessionList();
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────

	async onOpen(): Promise<void> {
		// Header actions
		this.addAction('plus', 'New conversation', () => void this.newConversation());

		this.buildUI();

		// Load persisted state before rendering lists
		this.sessionNames = this.plugin.settings.sessionNames ?? {};

		await this.loadAllConfigs();
		void this.loadSessions();

		// Watch synapse folder for config changes and auto-refresh
		this.registerConfigFileWatcher();

		// Track active note and editor selection
		this.updateActiveNote();
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.updateActiveNote())
		);
		this.startSelectionPolling();
	}

	async onClose(): Promise<void> {
		if (this.selectionPollTimer) { clearInterval(this.selectionPollTimer); this.selectionPollTimer = null; }
		if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
		if (this.basicSearchSession) {
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
		}
		await this.disconnectAllSessions();
	}

	// ── UI construction ──────────────────────────────────────────

	buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('synapse-root');

		// Main area (tab bar + panels)
		this.mainEl = root.createDiv({cls: 'synapse-main'});

		// Tab bar
		this.buildTabBar(this.mainEl);

		// ── Chat panel ───────────────────────────────────────
		this.chatPanelEl = this.mainEl.createDiv({cls: 'synapse-tab-panel synapse-tab-panel-chat'});

		// Chat content wrapper (chat + bottom)
		const chatContent = this.chatPanelEl.createDiv({cls: 'synapse-chat-content'});

		// Chat history (scrollable)
		this.chatContainer = chatContent.createDiv({cls: 'synapse-chat synapse-hide-debug'});
		this.renderWelcome();

		// Bottom panel
		const bottom = chatContent.createDiv({cls: 'synapse-bottom'});

		// Input area
		this.buildInputArea(bottom);

		// Config toolbar (agents, models, skills, tools, action buttons)
		this.buildConfigToolbar(bottom);

		// Splitter + session sidebar inside chat panel
		this.splitterEl = this.chatPanelEl.createDiv({cls: 'synapse-splitter'});
		this.initSplitter();
		this.buildSessionSidebar(this.chatPanelEl);

		// ── Search panel ─────────────────────────────────────
		this.searchPanelEl = this.mainEl.createDiv({cls: 'synapse-tab-panel synapse-tab-panel-search is-hidden'});
		this.buildSearchPanel(this.searchPanelEl);
	}

	buildTabBar(parent: HTMLElement): void {
		this.tabBarEl = parent.createDiv({cls: 'synapse-tab-bar'});
		const tabs: {id: 'chat' | 'search'; icon: string; label: string}[] = [
			{id: 'chat', icon: 'message-square', label: 'Chat'},
			{id: 'search', icon: 'search', label: 'Search'},
		];
		for (const tab of tabs) {
			const btn = this.tabBarEl.createDiv({cls: 'synapse-tab' + (tab.id === this.activeTab ? ' is-active' : '')});
			btn.dataset.tab = tab.id;
			const iconEl = btn.createSpan({cls: 'synapse-tab-icon'});
			setIcon(iconEl, tab.icon);
			btn.createSpan({cls: 'synapse-tab-label', text: tab.label});
			btn.addEventListener('click', () => this.switchTab(tab.id));
		}
	}

	switchTab(tab: 'chat' | 'search'): void {
		if (tab === this.activeTab) return;
		this.activeTab = tab;

		// Update tab bar active state
		this.tabBarEl.querySelectorAll('.synapse-tab').forEach(el => {
			el.toggleClass('is-active', (el as HTMLElement).dataset.tab === tab);
		});

		// Show/hide panels
		this.chatPanelEl.toggleClass('is-hidden', tab !== 'chat');
		this.searchPanelEl.toggleClass('is-hidden', tab !== 'search');
	}

	// ── Config loading ───────────────────────────────────────────

	async loadAllConfigs(options?: {silent?: boolean}): Promise<void> {
		if (this.configLoading) return;
		this.configLoading = true;
		try {
			// Lightweight scan for UI display
			const [agents, skills, triggers] = await Promise.all([
				scanAgents(this.app, normalizePath(`${SYNAPSE_FOLDER}/agents`)),
				scanSkills(this.app, normalizePath(`${SYNAPSE_FOLDER}/skills`)),
				scanTriggers(this.app, normalizePath(`${SYNAPSE_FOLDER}/triggers`)),
			]);
			this.agents = agents;
			this.skills = skills;
			this.triggers = triggers;

			// Enable all skills by default
			this.enabledSkills = new Set(this.skills.map(s => s.name));

			// Populate available models from AgentService
			if (this.plugin.copilot) {
				this.refreshProviderModels(this.plugin.copilot.getModels());
			}
		} catch (e) {
			console.error('Synapse: failed to load configs', e);
		} finally {
			this.configLoading = false;
			this.configLoadedAt = Date.now();
		}

		this.updateConfigUI();
		this.configDirty = true;
		if (!options?.silent) {
			new Notice(`Loaded ${this.agents.length} agent(s), ${this.models.length} model(s), ${this.skills.length} skill(s), ${this.triggers.length} trigger(s).`);
		}
	}

	refreshProviderModels(models: ModelInfo[]): void {
		this.models = models;

		const preferred = this.selectedModel;
		if (preferred && models.some(m => m.id === preferred)) {
			this.selectedModel = preferred;
		} else if (models.length > 0) {
			this.selectedModel = models[0]!.id;
		} else {
			this.selectedModel = '';
		}

		this.populateModelSelect();
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		}
	}

	registerConfigFileWatcher(): void {
		const DEBOUNCE_MS = 500;

		const scheduleRefresh = (filePath: string) => {
			const base = normalizePath(SYNAPSE_FOLDER);
			if (!filePath.startsWith(base + '/')) return;
			if (this.configLoading || (Date.now() - this.configLoadedAt < 2_000)) return;
			debugTrace(`Synapse: config file changed: ${filePath}`);
			if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
			this.configRefreshTimer = setTimeout(() => {
				this.configRefreshTimer = null;
				void this.loadAllConfigs({silent: true});
			}, DEBOUNCE_MS);
		};

		this.registerEvent(
			this.app.vault.on('modify', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				scheduleRefresh(file.path);
				scheduleRefresh(oldPath);
			})
		);
	}

	updateConfigUI(): void {
		// Agents
		this.agentSelect.empty();
		const noAgent = this.agentSelect.createEl('option', {text: 'Auto', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.agentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}
		if (this.selectedAgent && this.agents.some(a => a.name === this.selectedAgent)) {
			this.agentSelect.value = this.selectedAgent;
			const selAgent = this.agents.find(a => a.name === this.selectedAgent);
			this.agentSelect.title = selAgent ? selAgent.instructions : '';
		} else if (this.agents.length > 0 && this.agents[0]) {
			this.selectedAgent = this.agents[0].name;
			this.agentSelect.value = this.selectedAgent;
			this.agentSelect.title = this.agents[0].instructions;
		}

		// Auto-select agent's preferred model
		const selectedAgentConfig = this.agents.find(a => a.name === this.selectedAgent);
		const resolvedModel = this.resolveModelForAgent(selectedAgentConfig, this.selectedModel || undefined);
		if (resolvedModel) {
			this.selectedModel = resolvedModel;
		}

		// Models
		this.populateModelSelect();
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
		}

		// Apply agent's tools and skills filter
		const selectedAgentForFilter = this.agents.find(a => a.name === this.selectedAgent);
		this.applyAgentToolsAndSkills(selectedAgentForFilter);
		this.updateReasoningBadge();

		// Update search panel dropdowns
		if (this.searchAgentSelect) {
			this.updateSearchConfigUI();
		}
	}

	// ── Send & abort ─────────────────────────────────────────────

	async handleSend(): Promise<void> {
		const rawInput = this.inputEl.value.trim();
		if (!rawInput || this.isStreaming) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured.');
			return;
		}

		const prompt = rawInput;
		const displayPrompt = rawInput;

		// Snapshot attachments and scope
		const currentAttachments = [...this.attachments];
		// Auto-include live editor selection or active note
		if (this.activeSelection && !currentAttachments.some(a => a.type === 'selection' && a.path === this.activeSelection!.filePath && !a.absolutePath)) {
			const sel = this.activeSelection;
			const displayName = sel.startLine === sel.endLine
				? `${sel.fileName}:${sel.startLine}`
				: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
			currentAttachments.push({
				type: 'selection',
				name: displayName,
				path: sel.filePath,
				content: sel.text,
				selection: {
					startLine: sel.startLine,
					startChar: sel.startChar,
					endLine: sel.endLine,
					endChar: sel.endChar,
				},
			});
		} else if (this.activeNotePath && !currentAttachments.some(a => (a.type === 'file' || a.type === 'selection') && a.path === this.activeNotePath && !a.absolutePath)) {
			const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
			currentAttachments.push({type: 'file', name, path: this.activeNotePath});
		}

		// Auto-include note-embedded images (AC-1 through AC-8)
		if (this.plugin.settings.autoIncludeNoteImages && this.activeNotePath) {
			try {
				const noteFile = this.app.vault.getAbstractFileByPath(this.activeNotePath);
				if (noteFile instanceof TFile) {
					const noteContent = await this.app.vault.cachedRead(noteFile);
					const embeddedImages = resolveNoteImageEmbeds(noteContent, this.activeNotePath, this.app);

					// Determine effective cap: min of plugin setting and SDK model limit
					const selectedModelInfo = this.models.find(m => m.id === this.selectedModel);
					const sdkLimit = (selectedModelInfo?.capabilities?.limits as Record<string, unknown> | undefined)?.['vision'] as {max_prompt_images?: number} | undefined;
					const maxPromptImages = sdkLimit?.max_prompt_images;
					const configuredCap = Math.max(1, Math.min(20, this.plugin.settings.maxNoteImages));
					const effectiveCap = maxPromptImages != null ? Math.min(configuredCap, maxPromptImages) : configuredCap;

					// Deduplicate against manually attached images (match by vault-relative path)
					const existingPaths = new Set(
						currentAttachments
							.filter(a => (a.type === 'image' || a.type === 'file') && a.path && !a.absolutePath)
							.map(a => a.path)
					);

					let added = 0;
					for (const imgFile of embeddedImages) {
						if (added >= effectiveCap) break;
						if (existingPaths.has(imgFile.path)) continue;
						currentAttachments.push({
							type: 'image',
							name: imgFile.name,
							path: imgFile.path,
						});
						existingPaths.add(imgFile.path);
						added++;
					}
				}
			} catch (e) {
				console.error('[synapse] Failed to resolve note-embedded images:', e);
			}
		}

		const currentScopePaths = [...this.scopePaths];

		const sendPrompt = prompt;

		// Update UI
		this.addUserMessage(displayPrompt, currentAttachments, currentScopePaths);
		this.inputEl.value = '';
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.attachments = [];
		this.renderAttachments();

		// Begin streaming
		this.isStreaming = true;
		this.streamingContent = '';
		this.lastFullRenderLen = 0;
		this.clearReasoningState();
		this.updateSendButton();
		this.renderSessionList();  // Show green active dot
		this.addAssistantPlaceholder();

		try {
			await this.ensureSession();

			// Name the session if this is the first message
			if (this.currentSessionId && !this.sessionNames[this.currentSessionId]) {
				const agentName = this.selectedAgent || 'Chat';
				const truncated = prompt.length > 40 ? prompt.slice(0, 40) + '…' : prompt;
				this.sessionNames[this.currentSessionId] = `[chat] ${agentName}: ${truncated}`;
				this.saveSessionNames();
				this.renderSessionList();
			}

			const sdkAttachments = buildSdkAttachments({
				attachments: currentAttachments,
				scopePaths: this.scopePaths,
				vaultBasePath: this.getVaultBasePath(),
				app: this.app,
			});
			const fullPrompt = buildPrompt(sendPrompt, currentAttachments, this.cursorPosition, this.activeSelection);

			try {
				await this.currentSession!.send({
					prompt: fullPrompt,
					...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
				});
			} catch (sendErr) {
				// If the session is stale (e.g. SDK restarted), invalidate and retry once
				if (String(sendErr).includes('Session not found')) {
					this.unsubscribeEvents();
					this.currentSession = null;
					this.currentSessionId = null;
					this.configDirty = true;
					await this.ensureSession();
					this.registerSessionEvents();
					await this.currentSession!.send({
						prompt: fullPrompt,
						...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
					});
				} else {
					throw sendErr;
				}
			}
		} catch (e) {
			this.finalizeStreamingMessage();
			// DEBUG: log full error with stack trace
			console.error('[synapse] Send error:', e);
			if (e instanceof Error) {
				console.error('[synapse] Stack:', e.stack);
			}
			this.addInfoMessage(this.formatErrorForChat(String(e)));
		}
	}

	async handleAbort(): Promise<void> {
		if (this.currentSession) {
			try {
				await this.currentSession.abort();
			} catch { /* ignore */ }
		}

		// If no content was streamed yet, replace "Thinking..." with "Cancelled"
		if (!this.streamingContent && this.streamingBodyEl) {
			this.streamingBodyEl.empty();
			this.streamingBodyEl.createDiv({cls: 'synapse-thinking synapse-cancelled', text: 'Cancelled'});
		}

		this.finalizeStreamingMessage();
	}

	// ── Session management ───────────────────────────────────────

	async ensureSession(): Promise<void> {
		if (this.currentSession && !this.configDirty) return;

		// Tear down existing session
		if (this.currentSession) {
			this.unsubscribeEvents();
			try {
				await this.currentSession.disconnect();
			} catch { /* ignore */ }
			this.currentSession = null;
		}

		const sessionConfig = this.buildSessionConfig({
			model: this.selectedModel || undefined,
			selectedAgentName: this.selectedAgent || undefined,
		});

		this.earlyEventBuffer = [];
		const onEvent = (event: SessionEvent) => {
			if (this.earlyEventBuffer !== EMPTY_EVENT_BUFFER) {
				(this.earlyEventBuffer as SessionEvent[]).push(event);
			}
		};
		this.currentSession = await this.plugin.copilot!.createSession(sessionConfig, onEvent);
		this.currentSessionId = this.currentSession.sessionId;

		// Explicitly select the agent via RPC — the `agent` field in SessionConfig
		// should do this, but some CLI versions require the explicit call.
		if (sessionConfig.agent) {
			try {
				await this.currentSession.rpc.agent.select({name: sessionConfig.agent});
			} catch (e) {
				console.warn('[synapse] agent.select failed:', e);
			}
		}

		this.configDirty = false;
		this.registerSessionEvents();
		this.updateToolbarLock();

		// Add new session to list immediately so sidebar updates instantly
		if (!this.sessionList.some(s => s.sessionId === this.currentSession!.sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId: this.currentSession.sessionId,
				summary: '',
				lastModified: now.getTime(),
			} as import('./copilot').SessionMetadata);
		}
		this.renderSessionList();
	}

	/** Central event dispatcher — used by both onEvent (early) and typed handlers. */
	handleSessionEvent(event: SessionEvent): void {
		const type = event.type;
		const data = event.data as Record<string, unknown>;
		switch (type) {
			case 'assistant.turn_start':
				if (this.turnStartTime === 0) {
					this.turnStartTime = Date.now();
				}
				break;
			case 'assistant.reasoning_delta':
				this.appendReasoningDelta(data.deltaContent as string);
				break;
			case 'assistant.reasoning':
				if (typeof data.content === 'string' && data.content.length > 0) {
					this.syncReasoningContent(data.content);
				}
				this.finalizeReasoning();
				break;
			case 'assistant.message_delta':
				this.appendDelta(data.deltaContent as string);
				break;
			case 'assistant.message':
				if (typeof data.reasoningText === 'string' && data.reasoningText.length > 0) {
					this.syncReasoningContent(data.reasoningText);
					if (!this.reasoningComplete) this.finalizeReasoning();
				}
				if (typeof data.content === 'string' && data.content !== this.streamingContent) {
					this.streamingContent = data.content;
					if (this.streamingBodyEl) {
						void this.updateStreamingRender();
					}
				}
				break;
			case 'assistant.usage': {
				const d = data as {inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; model?: string};
				if (!this.turnUsage) {
					this.turnUsage = {
						inputTokens: d.inputTokens ?? 0,
						outputTokens: d.outputTokens ?? 0,
						cacheReadTokens: d.cacheReadTokens ?? 0,
						cacheWriteTokens: d.cacheWriteTokens ?? 0,
						model: d.model,
					};
				} else {
					this.turnUsage.inputTokens += d.inputTokens ?? 0;
					this.turnUsage.outputTokens += d.outputTokens ?? 0;
					this.turnUsage.cacheReadTokens += d.cacheReadTokens ?? 0;
					this.turnUsage.cacheWriteTokens += d.cacheWriteTokens ?? 0;
					if (d.model) this.turnUsage.model = d.model;
				}
				break;
			}
			case 'session.idle':
				if (this.streamingReasoning && !this.reasoningComplete) {
					this.finalizeReasoning();
				}
				this.finalizeStreamingMessage();
				break;
			case 'session.error': {
				const errMsg = (data as {message?: string; error?: string}).message ?? (data as {error?: string}).error ?? '';
				if (this.currentSession) {
					try { void this.currentSession.abort(); } catch { /* ignore */ }
				}
				this.finalizeStreamingMessage();
				this.addInfoMessage(this.formatErrorForChat(errMsg));
				break;
			}
			case 'tool.execution_start':
				this.turnToolsUsed.push(data.toolName as string);
				this.addToolCallBlock(data.toolCallId as string, data.toolName as string, data.arguments as string);
				break;
			case 'tool.execution_complete': {
				const toolError = data.error as {message: string} | undefined;
				this.completeToolCallBlock(
					data.toolCallId as string,
					data.success as boolean,
					data.result as {content?: string; detailedContent?: string} | undefined,
					toolError,
				);
				// Tool error guidance removed (BYOK cleanup)
				break;
			}
			case 'skill.invoked':
				this.turnSkillsUsed.push(data.name as string);
				break;
			case 'session.compaction_start':
				this.addCompactionStartBlock(data as {conversationTokens?: number; systemTokens?: number; toolDefinitionsTokens?: number});
				break;
			case 'session.compaction_complete':
				this.addCompactionCompleteBlock(data as {
					success: boolean;
					tokensRemoved?: number;
					messagesRemoved?: number;
					summaryContent?: string;
					preCompactionTokens?: number;
					postCompactionTokens?: number;
					error?: string;
				});
				break;
		}
	}

	registerSessionEvents(): void {
		if (!this.currentSession) return;
		const session = this.currentSession;

		// Replay any events that arrived via onEvent before typed handlers were registered
		const buffered = this.earlyEventBuffer;
		this.earlyEventBuffer = EMPTY_EVENT_BUFFER;
		for (const event of buffered) {
			this.handleSessionEvent(event);
		}

		// Register typed handlers for future events. The onEvent handler in
		// buildSessionConfig now delegates directly to handleSessionEvent,
		// so events arriving after this point are handled twice only if both
		// fire — but since onEvent fires for *all* events and the typed
		// handlers are more specific, they complement each other. We keep
		// the typed handlers for type-safety and because resumeSession paths
		// don't go through buildSessionConfig's onEvent.
		this.eventUnsubscribers.push(
			session.on('assistant.turn_start', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.reasoning_delta', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.reasoning', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.message_delta', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.message', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.usage', (event) => { this.handleSessionEvent(event); }),
			session.on('session.idle', (event) => { this.handleSessionEvent(event); }),
			session.on('session.error', (event) => { this.handleSessionEvent(event); }),
			session.on('tool.execution_start', (event) => { this.handleSessionEvent(event); }),
			session.on('tool.execution_complete', (event) => { this.handleSessionEvent(event); }),
			session.on('skill.invoked', (event) => { this.handleSessionEvent(event); }),
			session.on('session.compaction_start', (event) => { this.handleSessionEvent(event); }),
			session.on('session.compaction_complete', (event) => { this.handleSessionEvent(event); }),
		);
	}

	unsubscribeEvents(): void {
		for (const unsub of this.eventUnsubscribers) unsub();
		this.eventUnsubscribers = [];
		this.earlyEventBuffer = EMPTY_EVENT_BUFFER;
	}

	async disconnectSession(): Promise<void> {
		this.unsubscribeEvents();
		if (this.currentSession) {
			try {
				await this.currentSession.disconnect();
			} catch { /* ignore */ }
			this.currentSession = null;
		}
	}

	async disconnectAllSessions(): Promise<void> {
		await this.disconnectSession();
		for (const [, bg] of this.activeSessions) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.disconnect(); } catch { /* ignore */ }
			if (bg.streamingComponent) {
				try { this.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
		}
		this.activeSessions.clear();
	}

	newConversation(): void {
		// Save the current session to background instead of disconnecting it
		if (this.currentSession && this.currentSessionId) {
			this.saveCurrentToBackground();
		} else {
			// No active session handle, just clean up
			this.unsubscribeEvents();
			this.currentSession = null;
		}
		this.currentSessionId = null;
		this.messages = [];
		if (this.fullRenderTimer) {
			clearTimeout(this.fullRenderTimer);
			this.fullRenderTimer = null;
		}
		this.streamingContent = '';
		this.lastFullRenderLen = 0;
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();
		this.clearReasoningState();
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.isStreaming = false;
		this.configDirty = true;
		this.attachments = [];
		this.scopePaths = [];
		this.chatContainer.empty();
		this.renderWelcome();
		this.renderAttachments();
		this.renderScopeBar();
		this.updateSendButton();
		this.updateToolbarLock();
		this.renderSessionList();
	}

	// ── Session config building ──────────────────────────────────

	buildSessionConfig(opts: {
		model?: string;
		systemContent?: string;
		selectedAgentName?: string;
	}): SessionConfig {
		// Permission handler — canUseTool for Agent SDK
		const permissionHandler: import('./copilot').PermissionHandler = async (toolName, input, options) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return {behavior: 'allow' as const, ...(options.suggestions ? {updatedPermissions: options.suggestions} : {})};
			}
			const modal = new ToolApprovalModal(this.app, {
				toolName,
				input,
				title: options.title,
				displayName: options.displayName,
				description: options.description,
				suggestions: options.suggestions,
				toolUseID: options.toolUseID,
			});
			modal.open();
			return modal.promise;
		};

		// Elicitation handler — shows a form modal for structured input requests
		const elicitationHandler: import('./copilot').ElicitationHandler = (context) => {
			const modal = new ElicitationModal(this.app, context);
			modal.open();
			return modal.promise;
		};

		const reasoningEffort = this.plugin.settings.reasoningEffort;

		// Build workspace path info for system prompt
		const parts: string[] = [];
		const vaultRoot = this.getVaultBasePath().replace(/\\/g, '/');
		const activeFile = this.app.workspace.getActiveFile();
		const workDir = this.getWorkingDirectory().replace(/\\/g, '/');
		parts.push('[Workspace Path Information]');
		parts.push(`Vault root: ${vaultRoot}`);
		if (activeFile) {
			parts.push(`Active note: ${vaultRoot}/${activeFile.path}`);
		}
		parts.push(`Working directory: ${workDir}`);
		const wsInfo = parts.join('\n');
		const vaultContext = buildVaultContextBlock(this.app);
		let systemContent = (opts.systemContent
			? opts.systemContent + '\n\n' + wsInfo
			: wsInfo) + vaultContext;

		// Inject self-improve detection hint unless the user is already using the improve-synapse agent
		if (opts.selectedAgentName !== 'improve-synapse') {
			systemContent += buildSelfImproveHint(opts.selectedAgentName || 'Auto');
		}

		const config: SessionConfig = {
			model: opts.model,
			canUseTool: permissionHandler,
			onElicitation: elicitationHandler,
			cwd: this.getWorkingDirectory(),
			plugins: [{type: 'local', path: `${vaultRoot}/_synapse/`}],
			skills: Array.from(this.enabledSkills),
			agent: opts.selectedAgentName || this.plugin.settings.featureAgents?.chat || 'General',
			systemPrompt: systemContent,
			...(reasoningEffort !== '' ? {effort: reasoningEffort as ReasoningEffort} : {}),
		};

		return config;
	}

	// ── Utilities ────────────────────────────────────────────────

	/** Disable config controls that cannot be changed mid-session. */
	updateToolbarLock(): void {
		// No-op: all config changes set configDirty = true, which triggers
		// a new session on the next send. No need to lock controls.
	}

	getWorkingDirectory(): string {
		const base = this.getVaultBasePath();
		if (!this.workingDir) return base;
		return base + '/' + normalizePath(this.workingDir);
	}

	/** Format an error for display. */
	formatErrorForChat(rawError: string): string {
		const cleanError = rawError.startsWith('Error: ') ? rawError.slice(7) : rawError;
		return `Error: ${cleanError}`;
	}

	getVaultBasePath(): string {
		return (this.app.vault.adapter as unknown as {basePath: string}).basePath;
	}

	scrollToBottom(): void {
		// Only auto-scroll if user is near the bottom
		const threshold = 100;
		const isNear = this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight < threshold;
		if (isNear) {
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});
		}
	}

	forceScrollToBottom(): void {
		// Double rAF ensures layout is complete after markdown rendering
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});
		});
	}
}

// ── Install feature modules ─────────────────────────────────────
// These extend SynapseView.prototype with methods organized by feature area.
import {installChatRenderer} from './view/chatRenderer';
import {installSearchPanel} from './view/searchPanel';
import {installSessionSidebar} from './view/sessionSidebar';
import {installInputArea} from './view/inputArea';
import {installConfigToolbar} from './view/configToolbar';

installChatRenderer(SynapseView);
installSearchPanel(SynapseView);
installSessionSidebar(SynapseView);
installInputArea(SynapseView);
installConfigToolbar(SynapseView);
