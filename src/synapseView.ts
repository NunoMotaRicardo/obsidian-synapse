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
	TodoItem,
	SlashCommand,
	AgentInfo,
} from './agentService';
import {Session, parseTodoWritePayload, parseTaskCreateInput, parseTaskCreateResultId, parseTaskUpdateInput} from './agentService';
import type {AgentConfig, SkillInfo, TriggerConfig, ChatMessage, ChatAttachment} from './types';
import {scanAgents, scanSkills, scanTriggers} from './configWriter';
import {SYNAPSE_FOLDER, getVaultBasePath, getSynapsePluginConfig} from './vaultPaths';
import {debugTrace} from './debug';
import {ToolApprovalModal} from './modals/toolApprovalModal';
// UserInputModal removed — Agent SDK handles user input via hooks
import {ElicitationModal} from './modals/elicitationModal';
import type {BackgroundSession} from './view/types';

import {buildPrompt, cleanupAttachmentTempFiles, computeAdditionalDirectories, materializeBlobAttachments, resolveImageAttachments, buildLocalHistory, buildSdkHistoryInjection, computeSdkHistoryGap, buildSelfImproveHint, buildVaultContextBlock, buildResilienceHint, resolveNoteImageEmbeds} from './view/sessionConfig';
import {friendlyWriteToolError} from './toolErrors';

export const SYNAPSE_VIEW_TYPE = 'synapse-view';
/** Frozen sentinel — when earlyEventBuffer points here, onEvent stops buffering. */
const EMPTY_EVENT_BUFFER: readonly SessionEvent[] = Object.freeze([]);

// ── Synapse view ───────────────────────────────────────────────

export class SynapseView extends ItemView {
	plugin: SynapsePlugin;

	// ── State ────────────────────────────────────────────────────
	// Properties are non-private to allow access from view extension modules (src/view/).
	messages: ChatMessage[] = [];
	/**
	 * High-water mark (#137): index into `messages` up to which the *current* CLI/Agent SDK
	 * session already has the transcript — either because those turns were themselves sent via
	 * the SDK (advanced on every successful SDK-routed `send()`, see `handleSend()`), or because
	 * they were injected as a bridging history block into an earlier SDK turn. Turns sent via the
	 * local-provider branch (`AgentService.isLocalModel()`) never advance this mark, since they
	 * never reach the CLI — see `agent-service.md`'s "Bridging local-provider turns into the SDK
	 * session". Lives on `SynapseView`, not `Session`, deliberately: `ensureSession()` rebuilds
	 * the `Session` object on every `configDirty` change (issue #104), but the conversation
	 * transcript and this mark must survive that rebuild unchanged — resetting it on a config
	 * change (e.g. switching models) would immediately re-inject already-seen history on the next
	 * turn. Reset to `0` only when the conversation itself resets (`newConversation()`) or a
	 * different session is loaded (`selectSession()`/`restoreFromBackground()` in
	 * `sessionSidebar.ts`, which set it from the loaded transcript's length instead, since a
	 * cold-resumed or backgrounded session's `messages` already reflect exactly what that
	 * session's CLI transcript contains).
	 */
	sdkSeenIndex = 0;
	/**
	 * Last successful `supportedCommands()`/`supportedAgents()` capture (#130), held here
	 * rather than read only from `currentSession` (#163).
	 *
	 * The cache lives on `Session`, but `ensureSession()` builds a **new** `Session` on every
	 * `configDirty` change — switching model does it, via `applyReasoningToSession()` — and
	 * `newConversation()` replaces it outright. Reading only the current session's cache
	 * therefore made every CLI-provided slash command and subagent vanish from the pickers
	 * the moment the user changed a setting, falling back to the vault directory scan until
	 * the next turn completed. That looked like the user's skills disappearing.
	 *
	 * These lists describe the CLI installation and its cwd, not one conversation, so they
	 * stay valid across a session rebuild. Same reasoning as `sdkSeenIndex` above: state the
	 * rebuild must not destroy belongs on the view. Refreshed on every capture; the current
	 * session's own cache still wins when it has one.
	 */
	lastSupportedCommands: SlashCommand[] | null = null;
	lastSupportedAgents: AgentInfo[] | null = null;
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
	/** Absolute paths of temp files written for clipboard-pasted (blob) attachments — cleaned up on view unload. */
	attachmentTempFiles: Set<string> = new Set();

	// ── Slash-command skill popup state ──────────────────────────
	skillPopupEl: HTMLElement | null = null;
	/** Filtered skill list currently shown in the popup, in display order. */
	skillPopupMatches: SkillInfo[] = [];
	/** Index into `skillPopupMatches` of the highlighted row. */
	skillPopupSelectedIndex = 0;
	/** Start offset (in `inputEl.value`) of the `/` that triggered the popup. */
	skillPopupSlashIndex = -1;

	isStreaming = false;
	configDirty = true;
	streamingContent = '';
	renderScheduled = false;
	showDebugInfo = false;
	lastFullRenderLen = 0;
	fullRenderTimer: number | null = null;

	// ── Reasoning streaming state ──────────────────────────────
	streamingReasoning = '';
	reasoningEl: HTMLDetailsElement | null = null;
	reasoningBodyEl: HTMLElement | null = null;
	reasoningComplete = false;
	fullReasoningRenderTimer: number | null = null;

	// ── Turn-level metadata ────────────────────────────────────
	turnStartTime = 0;
	turnToolsUsed: string[] = [];
	turnSkillsUsed: string[] = [];
	turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null = null;
	activeToolCalls = new Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>();

	// ── Run-level guardrail counters (issue #88) ────────────────
	// Unlike turnStartTime/turnUsage above (reset per rendered assistant
	// message), these accumulate across an entire handleSend() run — a run can
	// span several `assistant.turn_start` events (tool-use loops) before
	// `session.idle`. Reset at the start of every handleSend() call, not at
	// finalizeStreamingMessage() (which fires per rendered message).
	runTurnCount = 0;
	runUsage: {totalTokens: number} = {totalTokens: 0};
	/** True once handleAbort() has been triggered by a threshold in the current run, so the resulting session.idle/error doesn't also re-report it. */
	runAutoCancelled = false;

	// ── Task/plan tracking (TodoWrite, or TaskCreate/TaskUpdate) ─
	/** Current plan's sub-tasks, from the most recent `TodoWrite` call this turn. `null` = no plan yet. */
	currentTodos: TodoItem[] | null = null;
	/** Root element of the live task panel for the current turn, if a plan exists. */
	taskPanelEl: HTMLElement | null = null;
	/** Ticks while a task panel is visible to keep its elapsed-runtime label live. */
	taskPanelTimer: ReturnType<typeof setInterval> | null = null;
	/** Incrementally-built plan from `TaskCreate`/`TaskUpdate` calls this turn (taskId -> item), the newer sibling of `TodoWrite`. */
	taskPlan: Map<string, TodoItem> = new Map();
	/** `TaskCreate` calls awaiting their `tool.execution_complete` result, which carries the server-assigned task id. */
	pendingTaskCreates: Map<string, {subject: string; activeForm?: string}> = new Map();

	// ── Session sidebar state ──────────────────────────────────
	activeSessions = new Map<string, BackgroundSession>();
	sessionList: import('./agentService').SessionMetadata[] = [];
	sessionNames: Record<string, string> = {};
	currentSessionId: string | null = null;
	/** First-prompt snippet used to name a new session once its id arrives via 'session.init'. */
	pendingSessionLabel: string | null = null;
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
	toolsBtnEl!: HTMLButtonElement;
	cwdBtnEl!: HTMLButtonElement;
	/** Context-window gauge (issue #130) — absent (`is-hidden`) until the first successful capture; see `updateContextIndicator()`. */
	contextIndicatorEl!: HTMLElement;
	debugBtnEl!: HTMLElement;
	streamingComponent: Component | null = null;
	streamingWrapperEl: HTMLElement | null = null;

	// ── Config file watcher ──────────────────────────────────────
	configRefreshTimer: number | null = null;
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
		this.selectedAgent = this.plugin.settings?.featureAgents?.chat ?? '';
		this.selectedModel = '';
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
		if (!sessionId) return; // no id (e.g. aborted query) — don't create a junk entry
		this.sessionNames[sessionId] = `[inline] ${description}`;
		this.saveSessionNames();

		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				summary: '',
				lastModified: now.getTime(),
			});
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
		// Drop legacy junk entries keyed by an empty session id (written by older
		// builds that named sessions before the SDK delivered the real id).
		if ('' in this.sessionNames) {
			delete this.sessionNames[''];
			this.saveSessionNames();
		}

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
		if (this.selectionPollTimer) { window.clearInterval(this.selectionPollTimer); this.selectionPollTimer = null; }
		if (this.configRefreshTimer) window.clearTimeout(this.configRefreshTimer);
		if (this.basicSearchSession) {
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
		}
		await this.disconnectAllSessions();
		if (this.attachmentTempFiles.size > 0) {
			await cleanupAttachmentTempFiles(Array.from(this.attachmentTempFiles));
			this.attachmentTempFiles.clear();
		}
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
			if (this.plugin.agentService) {
				this.refreshProviderModels(this.plugin.agentService.getModels());
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
		if (preferred === '') {
			// Stay at '' (Default model)
		} else if (preferred && models.some(m => m.id === preferred)) {
			this.selectedModel = preferred;
		} else {
			this.selectedModel = '';
		}

		this.populateModelSelect();
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else {
			this.modelSelect.value = '';
		}
	}

	registerConfigFileWatcher(): void {
		const DEBOUNCE_MS = 500;

		const scheduleRefresh = (filePath: string) => {
			const base = normalizePath(SYNAPSE_FOLDER);
			if (!filePath.startsWith(base + '/')) return;
			if (this.configLoading || (Date.now() - this.configLoadedAt < 2_000)) return;
			debugTrace(`Synapse: config file changed: ${filePath}`);
			if (this.configRefreshTimer) window.clearTimeout(this.configRefreshTimer);
			this.configRefreshTimer = window.setTimeout(() => {
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
		// Agents — sourced from the live CLI's supportedAgents() (issue #130) when a session
		// has captured one, else the directory scan; see `getEffectiveAgents()`.
		const agents = this.getEffectiveAgents();
		this.agentSelect.empty();
		const noAgent = this.agentSelect.createEl('option', {text: 'Auto', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of agents) {
			const opt = this.agentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}
		if (this.selectedAgent === '') {
			this.agentSelect.value = '';
			this.agentSelect.title = '';
		} else if (this.selectedAgent && agents.some(a => a.name === this.selectedAgent)) {
			this.agentSelect.value = this.selectedAgent;
			const selAgent = agents.find(a => a.name === this.selectedAgent);
			this.agentSelect.title = selAgent ? selAgent.instructions : '';
		} else {
			this.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.title = '';
		}

		// Auto-select agent's preferred model
		const selectedAgentConfig = agents.find(a => a.name === this.selectedAgent);
		const resolvedModel = this.resolveModelForAgent(selectedAgentConfig, this.selectedModel || undefined);
		if (resolvedModel) {
			this.selectedModel = resolvedModel;
		}

		// Models
		this.populateModelSelect();
		if (this.selectedModel === '') {
			this.modelSelect.value = '';
		} else if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else {
			this.selectedModel = '';
			this.modelSelect.value = '';
		}

		// Apply agent's tools and skills filter
		const selectedAgentForFilter = agents.find(a => a.name === this.selectedAgent);
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

		if (!this.plugin.agentService) {
			new Notice('Synapse is not configured.');
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
					const sdkLimit = selectedModelInfo?.capabilities?.limits?.['vision'] as {max_prompt_images?: number} | undefined;
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

		// Reset run-level guardrail counters (issue #88) — a fresh run starts here,
		// distinct from the per-message turnStartTime/turnUsage reset in
		// finalizeStreamingMessage().
		this.runTurnCount = 0;
		this.runUsage = {totalTokens: 0};
		this.runAutoCancelled = false;

		try {
			await this.ensureSession();

			// Remember the first prompt so the session can be named once the SDK
			// assigns a session id (delivered via the 'session.init' event during
			// the first send — the id is not known before that).
			this.pendingSessionLabel = prompt.length > 40 ? prompt.slice(0, 40) + '…' : prompt;

			// Clipboard-pasted image attachments (type: 'blob', base64 data, no path) are
			// written to temp files first so they can be inlined into the prompt like any
			// other file attachment. Temp files are tracked for cleanup on session end / unload.
			const vaultBasePath = this.getVaultBasePath();
			const blobPaths = await materializeBlobAttachments(currentAttachments);
			for (const tempPath of blobPaths.values()) {
				this.attachmentTempFiles.add(tempPath);
			}

			const fullPrompt = buildPrompt(sendPrompt, currentAttachments, this.cursorPosition, this.activeSelection, vaultBasePath, blobPaths, currentScopePaths);
			const additionalDirectories = computeAdditionalDirectories({
				attachments: currentAttachments,
				blobPaths,
				vaultBasePath,
				workingDirectory: this.getWorkingDirectory(),
				scopePaths: currentScopePaths,
				app: this.app,
			});

			// Local/BYOK models have no agentic Read tool, so a path inlined into the prompt
			// (buildPrompt(), above) isn't enough for them to actually see image content —
			// resolve base64 image data instead. Skipped entirely for cloud/SDK models to
			// avoid unnecessary file I/O, since they can Read the inlined path themselves.
			const isLocalModel = this.plugin.agentService?.isLocalModel(this.selectedModel || undefined);
			const images = isLocalModel
				? await resolveImageAttachments(currentAttachments, blobPaths, vaultBasePath)
				: undefined;

			// Conversation history (#135) — local models have no SDK-side session/resume
			// mechanism, so continuity has to be sent explicitly. `this.messages` already has
			// the just-added current-turn user message pushed by addUserMessage() above (line
			// ~579), so it's excluded here — the current turn goes through `prompt`, not
			// `history`. Cloud/SDK models get continuity from `resume` instead (agent-service.md)
			// and don't need this at all.
			const history = isLocalModel
				? await buildLocalHistory(this.messages.slice(0, -1), vaultBasePath)
				: undefined;

			// Bridge the two-store gap (#137): local-provider turns never reach the CLI, so a
			// conversation that switches from a local model back to Claude (or starts on a
			// local model entirely) resumes a CLI session missing those turns. `sdkSeenIndex`
			// marks how much of `this.messages` the CLI already has; anything since then (and
			// before the just-added current-turn user message, excluded the same way `history`
			// above excludes it) is injected as a delimited transcript block prepended to the
			// prompt. Only relevant for the real Agent SDK branch — local models get continuity
			// from `history` instead and never touch `sdkSeenIndex` (see its field doc comment).
			let promptForSend = fullPrompt;
			if (!isLocalModel) {
				const gapMessages = computeSdkHistoryGap(this.messages, this.sdkSeenIndex);
				const injection = buildSdkHistoryInjection(gapMessages);
				if (injection) promptForSend = injection + fullPrompt;
			}

			try {
				await this.currentSession!.send({
					prompt: promptForSend,
					...(additionalDirectories.length > 0 ? {additionalDirectories} : {}),
					...(images && images.length > 0 ? {images} : {}),
					...(history && history.length > 0 ? {history} : {}),
					// Only meaningful in the local-model branch (#138) — vault tools
					// execute against this. Passed unconditionally; unused on the real
					// Agent SDK path.
					app: this.app,
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
						prompt: promptForSend,
						...(additionalDirectories.length > 0 ? {additionalDirectories} : {}),
						...(images && images.length > 0 ? {images} : {}),
						...(history && history.length > 0 ? {history} : {}),
						app: this.app,
					});
				} else {
					throw sendErr;
				}
			}

			// The turn above just reached the CLI successfully (either call — a thrown error
			// from either would have skipped this line via the catch above). Advance the mark
			// so the next SDK turn doesn't re-inject what the CLI now has — including this
			// turn's own prompt/response, which is why this uses `this.messages.length` (after
			// `finalizeStreamingMessage()` has already pushed the assistant reply — see
			// `agent-service.md`: `session.idle` fires synchronously inside `send()`, before it
			// resolves here) rather than the pre-turn snapshot.
			if (!isLocalModel) {
				this.sdkSeenIndex = this.messages.length;
			}
		} catch (e) {
			this.finalizeStreamingMessage();
			// DEBUG: log full error with stack trace
			console.error('[synapse] Send error:', e);
			if (e instanceof Error) {
				console.error('[synapse] Stack:', e.stack);
			}
			// A guardrail-triggered abort (checkLoopThresholds() -> handleAbort()) rejects
			// this send() call — that rejection is an expected consequence of the abort, not
			// a second failure. The guardrail's specific reason was already shown; don't
			// re-report it here as a generic "Error: Operation aborted". Same rationale as
			// the session.error handler above.
			if (!this.runAutoCancelled) {
				this.addInfoMessage(this.formatErrorForChat(String(e)));
			}
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

	/**
	 * Interactive Tier-1 loop guardrails (issue #88). Checked on every
	 * `assistant.turn_start` / `assistant.usage` event for the current run
	 * (reset per handleSend() call — see runTurnCount/runUsage). Distinct from
	 * the SDK's raw `maxTurns`: this is a plugin-side cap that auto-cancels via
	 * `Session.abort()` (the same path `session.error` already uses) and shows
	 * a clear, specific reason — not the SDK's silent "reached max turns".
	 *
	 * Only the turn and token thresholds are enforced here in real time —
	 * dollar cost is only known after a run finishes (see
	 * `assistant.run_result` handling above / specs/agent-service.md), so it
	 * can't drive in-flight cancellation and is surfaced separately.
	 *
	 * Turn check is `>` (not `>=`): `runTurnCount` is incremented on
	 * `assistant.turn_start` *before* this runs, so by the time turn N is seen
	 * the model has already completed N turns of work. `>` lets the run
	 * complete up to `turnLimit` turns and only cancels once it tries to go
	 * beyond that — `>=` would cancel on the very first turn for a limit of 1,
	 * allowing zero turns of actual work.
	 */
	checkLoopThresholds(): void {
		if (this.runAutoCancelled || !this.isStreaming) return;

		const turnLimit = this.plugin.settings.loopTurnThreshold;
		const tokenLimit = this.plugin.settings.loopTokenThreshold;

		let reason: string | null = null;
		if (turnLimit > 0 && this.runTurnCount > turnLimit) {
			reason = `Synapse: run auto-cancelled — reached the turn limit of ${turnLimit.toLocaleString()} (Settings → Capabilities → Turn limit).`;
		} else if (tokenLimit > 0 && this.runUsage.totalTokens >= tokenLimit) {
			reason = `Synapse: run auto-cancelled — reached the token budget of ${tokenLimit.toLocaleString()} tokens (Settings → Capabilities → Token budget).`;
		}
		if (!reason) return;

		this.runAutoCancelled = true;
		this.addInfoMessage(reason);
		void this.handleAbort();
	}

	// ── Session management ───────────────────────────────────────

	async ensureSession(): Promise<void> {
		if (this.currentSession && !this.configDirty) return;

		// Carry the conversation across a configDirty rebuild: the outgoing session's
		// sessionId (once it has one — a session that never sent a message has none to
		// carry) is threaded through as `resume` on the rebuilt config below. Without
		// this, the new Session() starts with an empty `_sessionId` and no seeding path,
		// so send() silently omits `resume` and the conversation is lost on every config
		// change (issue #104).
		const resumeSessionId = this.currentSession?.sessionId || undefined;

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
			selectedAgentName: this.selectedAgent,
			resume: resumeSessionId,
		});

		this.earlyEventBuffer = [];
		const onEvent = (event: SessionEvent) => {
			if (this.earlyEventBuffer !== EMPTY_EVENT_BUFFER) {
				(this.earlyEventBuffer as SessionEvent[]).push(event);
			}
		};
		this.currentSession = await this.plugin.agentService!.createSession(sessionConfig, onEvent);
		// For a brand-new session the id is unknown until the first send() streams a
		// message; 'session.init' delivers it (handled in handleSessionEvent).
		this.currentSessionId = this.currentSession.sessionId || null;

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
		// A rebuilt Session starts with an empty query-metadata cache (issue #130) — hide
		// the gauge and fall back to the directory scan for agents/skills until this
		// session's own first turn captures fresh values.
		this.updateContextIndicator();
		this.updateToolbarLock();

		// Add resumed sessions to the list immediately; brand-new sessions are added
		// when 'session.init' delivers their real id (an empty-id entry here would
		// leave a junk row the sidebar can never resolve).
		if (this.currentSessionId && !this.sessionList.some(s => s.sessionId === this.currentSessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId: this.currentSessionId,
				summary: '',
				lastModified: now.getTime(),
			});
		}
		this.renderSessionList();
	}

	/** Central event dispatcher — used by both onEvent (early) and typed handlers. */
	handleSessionEvent(event: SessionEvent): void {
		const type = event.type;
		const data = event.data;
		switch (type) {
			case 'session.init': {
				// First message of a new session delivered its id — adopt it, name the
				// session from the first prompt, and surface it in the sidebar.
				const sessionId = data.sessionId as string;
				if (!sessionId) break;
				this.currentSessionId = sessionId;
				if (!this.sessionNames[sessionId] && this.pendingSessionLabel) {
					const agentName = this.selectedAgent || 'Chat';
					this.sessionNames[sessionId] = `[chat] ${agentName}: ${this.pendingSessionLabel}`;
					this.saveSessionNames();
				}
				this.pendingSessionLabel = null;
				if (!this.sessionList.some(s => s.sessionId === sessionId)) {
					this.sessionList.unshift({
						sessionId,
						summary: '',
						lastModified: Date.now(),
					});
				}
				this.renderSessionList();
				break;
			}
			case 'assistant.turn_start':
				if (this.turnStartTime === 0) {
					this.turnStartTime = Date.now();
				}
				this.runTurnCount++;
				this.checkLoopThresholds();
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
				// input + output only — `assistant.usage` (dispatched in agentService.ts)
				// never carries cache token fields, so summing them here would always add 0
				// while implying cache usage is tracked. See specs/chat-view.md.
				this.runUsage.totalTokens += (d.inputTokens ?? 0) + (d.outputTokens ?? 0);
				this.checkLoopThresholds();
				break;
			}
			case 'assistant.run_result': {
				// Dollar cost is only known once the run has already finished (see
				// agentService.ts) — can't auto-cancel on it, but can flag it after
				// the fact rather than silently ignoring an over-budget run (#88/AC-2).
				const costThreshold = this.plugin.settings.loopCostThresholdUsd;
				const totalCostUsd = (data as {totalCostUsd?: number}).totalCostUsd;
				if (costThreshold > 0 && typeof totalCostUsd === 'number' && totalCostUsd >= costThreshold) {
					this.addInfoMessage(
						`Synapse: this run cost $${totalCostUsd.toFixed(4)}, over your $${costThreshold.toFixed(2)} budget. ` +
						`Cost is only known once a run finishes, so it couldn't be stopped in-flight — use the turn or token limit in Settings for real-time auto-cancellation.`
					);
				}
				break;
			}
			case 'session.idle':
				if (this.streamingReasoning && !this.reasoningComplete) {
					this.finalizeReasoning();
				}
				this.finalizeStreamingMessage();
				// Agent/skill lists refresh here rather than on `session.metadata` (issue
				// #130): that event fires once per `assistant` message, and `updateConfigUI()`
				// mutates session configuration (see the `session.metadata` case). The cache
				// is one turn stale by design, so end-of-turn is the natural refresh point.
				this.updateConfigUI();
				break;
			case 'session.error': {
				const errMsg = (data as {message?: string; error?: string}).message ?? (data as {error?: string}).error ?? '';
				if (this.currentSession) {
					try { void this.currentSession.abort(); } catch { /* ignore */ }
				}
				this.finalizeStreamingMessage();
				// checkLoopThresholds() already reported the specific guardrail reason and
				// triggered this abort — the resulting session.error is an expected
				// consequence of that cancellation, not a second failure to report.
				if (!this.runAutoCancelled) {
					this.addInfoMessage(this.formatErrorForChat(errMsg));
				}
				break;
			}
			case 'tool.execution_start': {
				const toolName = data.toolName as string;
				this.turnToolsUsed.push(toolName);
				const toolInput = (data as {input?: unknown}).input;
				if (toolName === 'TodoWrite') {
					const todos = parseTodoWritePayload(toolInput);
					if (todos) {
						this.renderTaskPanel(todos);
						break;
					}
					// Payload didn't look like a TodoWrite plan — fall through to generic rendering.
				} else if (toolName === 'TaskCreate') {
					const parsed = parseTaskCreateInput(toolInput);
					if (parsed) {
						// The id is only known once the result arrives — stash the fields keyed by
						// toolCallId so tool.execution_complete can add the entry to taskPlan.
						this.pendingTaskCreates.set(data.toolCallId as string, parsed);
						break;
					}
				} else if (toolName === 'TaskUpdate') {
					const parsed = parseTaskUpdateInput(toolInput);
					if (parsed && this.taskPlan.has(parsed.taskId)) {
						// The CLI also emits TaskUpdate calls that only touch untracked fields
						// (e.g. dependencies) — parsed.status/subject/activeForm are all
						// undefined in that case. Skip the map mutation and DOM rebuild when
						// nothing displayable actually changed, rather than churning the panel
						// on every dependency-only update during an agentic loop.
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
							this.renderTaskPanel([...this.taskPlan.values()]);
						}
						break;
					}
				}
				this.addToolCallBlock(data.toolCallId as string, toolName, toolInput);
				break;
			}
			case 'tool.execution_complete': {
				const toolError = data.error as {message: string} | undefined;
				const toolName = data.toolName as string | undefined;
				const toolCallId = data.toolCallId as string;
				if (toolName === 'TaskCreate' && this.pendingTaskCreates.has(toolCallId)) {
					const pending = this.pendingTaskCreates.get(toolCallId)!;
					this.pendingTaskCreates.delete(toolCallId);
					const resultText = (data.result as {content?: string} | undefined)?.content;
					const taskId = !toolError ? parseTaskCreateResultId(resultText) : null;
					if (taskId) {
						this.taskPlan.set(taskId, {content: pending.subject, status: 'pending', activeForm: pending.activeForm});
						this.renderTaskPanel([...this.taskPlan.values()]);
					}
					break;
				}
				this.completeToolCallBlock(
					toolCallId,
					data.success as boolean,
					data.result as {content?: string; detailedContent?: string} | undefined,
					toolError,
				);
				// Surface a clear, actionable message for transient-looking write/edit
				// failures (e.g. a file locked by sync or open elsewhere) instead of
				// leaving the user to dig the raw error out of the collapsed tool block.
				if (toolError) {
					const friendly = friendlyWriteToolError(toolName, toolError.message);
					if (friendly) this.addInfoMessage(friendly);
				}
				break;
			}
			case 'skill.invoked':
				this.turnSkillsUsed.push(data.name as string);
				break;
			case 'session.compaction_complete':
				this.addCompactionCompleteBlock(data);
				break;
			case 'session.metadata':
				// Capture-and-cache refresh (issue #130) — Session already holds the
				// authoritative cache (`cachedContextUsage`/`cachedSupportedCommands`/
				// `cachedSupportedAgents`); this event just tells the view it's time to
				// re-read those getters.
				//
				// Only the read-only gauge refreshes here. This event fires once per
				// `assistant` message, i.e. repeatedly *mid-turn*, and `updateConfigUI()`
				// is not a read-only render: it rebuilds the agent `<select>`, resets
				// `selectedAgent` when the newly-preferred list doesn't contain the current
				// selection, and re-runs `applyAgentToolsAndSkills()`, which rewrites
				// `enabledSkills`. Doing that while a turn is in flight would mutate the
				// session's own configuration underneath it. The agent/skill lists refresh
				// on `session.idle` instead.
				//
				// The captured lists are also mirrored onto the view so they survive the
				// `Session` rebuild that any config change triggers (#163) — see
				// `lastSupportedCommands`.
				if (this.currentSession?.cachedSupportedCommands) {
					this.lastSupportedCommands = this.currentSession.cachedSupportedCommands;
				}
				if (this.currentSession?.cachedSupportedAgents) {
					this.lastSupportedAgents = this.currentSession.cachedSupportedAgents;
				}
				this.updateContextIndicator();
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

		// Register typed handlers for future events.
		//
		// **This list is the only live delivery path, so an event type missing from it is
		// silently never handled.** `ensureSession()`'s `onEvent` callback does not delegate
		// to `handleSessionEvent` — it only *buffers* events until this method runs, and once
		// `earlyEventBuffer` is swapped for `EMPTY_EVENT_BUFFER` above it drops everything it
		// receives. (A previous version of this comment claimed onEvent delegated directly;
		// it does not, and #130's `session.metadata` was dead on arrival because of it.)
		// Add every new SessionEvent type here.
		this.eventUnsubscribers.push(
			session.on('session.init', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.turn_start', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.reasoning_delta', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.reasoning', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.message_delta', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.message', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.usage', (event) => { this.handleSessionEvent(event); }),
			session.on('assistant.run_result', (event) => { this.handleSessionEvent(event); }),
			session.on('session.idle', (event) => { this.handleSessionEvent(event); }),
			session.on('session.error', (event) => { this.handleSessionEvent(event); }),
			session.on('tool.execution_start', (event) => { this.handleSessionEvent(event); }),
			session.on('tool.execution_complete', (event) => { this.handleSessionEvent(event); }),
			session.on('skill.invoked', (event) => { this.handleSessionEvent(event); }),
			session.on('session.compaction_complete', (event) => { this.handleSessionEvent(event); }),
			session.on('session.metadata', (event) => { this.handleSessionEvent(event); }),
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
		this.updateContextIndicator();
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
		this.pendingSessionLabel = null;
		this.messages = [];
		this.sdkSeenIndex = 0;
		if (this.fullRenderTimer) {
			window.clearTimeout(this.fullRenderTimer);
			this.fullRenderTimer = null;
		}
		this.streamingContent = '';
		this.lastFullRenderLen = 0;
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();
		this.clearReasoningState();
		this.clearTaskPanelState();
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.isStreaming = false;
		this.selectedAgent = this.plugin.settings.featureAgents?.chat ?? '';
		this.selectedModel = '';
		this.updateConfigUI();
		this.updateContextIndicator();
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
		/**
		 * Session id to resume, for rebuilding a session that already had a conversation
		 * (e.g. a `configDirty` rebuild in `ensureSession()`) — carried into the new
		 * `Session`'s config so `send()` passes `resume` even though the fresh `Session`
		 * itself starts with an empty `_sessionId` (see `ensureSession()`).
		 */
		resume?: string;
	}): SessionConfig {
		// Permission handler — canUseTool for Agent SDK
		const permissionHandler: import('./agentService').PermissionHandler = async (toolName, input, options) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return {
					behavior: 'allow' as const,
					updatedInput: input,
					...(options.suggestions ? {updatedPermissions: options.suggestions} : {}),
				};
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
		const elicitationHandler: import('./agentService').ElicitationHandler = (context) => {
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
			: wsInfo) + vaultContext + buildResilienceHint();

		const effectiveAgentName = opts.selectedAgentName !== undefined ? opts.selectedAgentName : (this.plugin.settings.featureAgents?.chat || '');

		// Inject self-improve detection hint unless the user is already using the improve-synapse agent
		if (effectiveAgentName !== 'improve-synapse') {
			systemContent += buildSelfImproveHint(effectiveAgentName || 'Auto');
		}

		const config: SessionConfig = {
			model: opts.model,
			// Interactive chat panel only (issue #103) — real token-level streaming instead
			// of one lump per turn. One-shot helpers (chat/inlineChat) and unattended paths
			// (search, triggers, Telegram, batch loops) don't go through buildSessionConfig
			// and gain nothing from the extra stream_event volume.
			includePartialMessages: true,
			canUseTool: permissionHandler,
			onElicitation: elicitationHandler,
			cwd: this.getWorkingDirectory(),
			plugins: getSynapsePluginConfig(this.app),
			skills: Array.from(this.enabledSkills),
			agent: effectiveAgentName || undefined,
			// Append to the Claude Code preset rather than replacing it — a plain
			// string here would wipe the default system prompt (tool usage, agentic
			// behavior) and the model stops using tools or reading files.
			systemPrompt: {type: 'preset', preset: 'claude_code', append: systemContent},
			...(reasoningEffort !== '' ? {effort: reasoningEffort as ReasoningEffort} : {}),
			...(opts.resume ? {resume: opts.resume} : {}),
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
		return getVaultBasePath(this.app);
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
