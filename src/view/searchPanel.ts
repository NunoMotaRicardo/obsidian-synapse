import {Menu, Notice, TFile, setIcon} from 'obsidian';
import {autoApproveReadOnlyTools, type SessionConfig} from '../agentService';
import type {Session} from '../agentService';
import type {AgentConfig} from '../types';
import {FolderTreeModal} from '../modals';
import {buildCurrentAgentLine, buildResilienceHint, buildSelfImproveHint, getAdaptiveTimeout} from './sessionConfig';
import {getSynapsePluginConfig} from '../vaultPaths';
import type {ViewContext} from './types';

/** Read-only file tools for vault search — no write/exec access needed. */
const SEARCH_TOOLS = ['Read', 'Glob', 'Grep'];

/** Max characters shown for the working-directory folder name before truncating with an ellipsis (#215). */
const CWD_LABEL_MAX_CHARS = 14;

/** Shared search prompt: instructs tool-driven exploration + strict JSON output. */
function buildSearchPrompt(query: string): string {
	return 'Search the vault (your working directory) for files matching the query below. ' +
		'Use your Glob/Grep/Read tools to explore file names and contents. ' +
		'Then return ONLY a JSON array of objects, each with "file" (vault-relative path), ' +
		'"folder" (parent folder path), and "reason" (brief description why it matches). ' +
		'Sort by relevance (best match first). Return [] if nothing matches. ' +
		'No markdown fences, no extra text.\n\nQuery: ' + query;
}

/** Highlight query terms in result text using .synapse-search-highlight (accent color, no yellow fill). */
function highlightQueryTerms(container: HTMLElement, text: string, query?: string): void {
	if (!query) {
		container.setText(text);
		return;
	}

	const terms = query
		.split(/\s+/)
		.map(t => t.replace(/[^\w-]/g, ''))
		.filter(t => t.length >= 2);

	if (terms.length === 0) {
		container.setText(text);
		return;
	}

	const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const regex = new RegExp(`(${escaped.join('|')})`, 'gi');

	const parts = text.split(regex);

	container.empty();
	for (const part of parts) {
		if (regex.test(part)) {
			container.createEl('mark', {cls: 'synapse-search-highlight', text: part});
		} else if (part) {
			container.appendText(part);
		}
	}
}

/**
 * Search tab controller (composition refactor — formerly prototype injection into
 * `SynapseView`, `.docs/research/2026-09-11-view-composition-refactor.md`). Owns all
 * search-panel state: the composer/toolbar DOM refs, the selected search
 * agent/model/skills, the search working directory, and the live search sessions.
 * Reaches shared view state (session list, session names, tab switching) through its
 * `ViewContext`.
 *
 * The basic/advanced mode is *not* controller state — it is the persisted
 * `plugin.settings.searchMode`, read via the `searchMode` getter.
 */
export class SearchPanelController {
	// ── Panel state (moved from SynapseView) ─────────────────────
	searchAgent = '';
	searchModel = '';
	searchWorkingDir = '';
	searchEnabledSkills: Set<string> = new Set();
	private searchAgentSelect!: HTMLSelectElement;
	private searchModelSelect!: HTMLSelectElement;
	private searchToolsBtnEl!: HTMLButtonElement;
	private searchCwdBtnEl!: HTMLButtonElement;
	private searchScopeBtn?: HTMLButtonElement;
	private searchStateLineEl?: HTMLElement;
	private searchInputEl!: HTMLTextAreaElement;
	private searchBtnEl!: HTMLButtonElement;
	private searchResultsEl!: HTMLElement;
	private searchModeToggleEl!: HTMLButtonElement;
	private searchAdvancedToolbarEl!: HTMLElement;
	private searchAbortController: AbortController | null = null;
	/** The advanced-mode session (persists across queries to resume context). */
	searchSession: Session | null = null;
	/** The basic-mode cached session (one-shot searches, no ongoing transcript). */
	basicSearchSession: Session | null = null;
	isSearching = false;

	constructor(private view: ViewContext) {}

	/** The persisted search mode — a setting, not controller state. */
	get searchMode(): 'basic' | 'advanced' {
		return this.view.plugin.settings.searchMode;
	}

	getSearchWorkingDirectory(): string {
		const base = this.view.getVaultBasePath();
		if (!this.searchWorkingDir) return base;
		return base + '/' + this.searchWorkingDir;
	}

	/** Build the whole search panel into `parent`. */
	build(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'synapse-search-wrapper'});

		// Composer container (state line + textarea + unified toolbar)
		const composer = wrapper.createDiv({cls: 'synapse-search-composer'});

		// ── State line: working directory / scope ──
		this.searchStateLineEl = composer.createDiv({cls: 'synapse-state-line synapse-search-state-line'});

		this.searchCwdBtnEl = this.searchStateLineEl.createEl('button', {
			cls: 'synapse-toolbar-btn synapse-cwd-btn',
			attr: {type: 'button'},
		});
		this.searchCwdBtnEl.addEventListener('click', () => this.openSearchScopePicker());

		this.searchScopeBtn = this.searchStateLineEl.createEl('button', {
			cls: 'synapse-toolbar-btn synapse-f-btn synapse-f-btn-scope',
			attr: {title: 'Select search scope', 'aria-label': 'Scope', type: 'button'},
		});
		const scopeIcon = this.searchScopeBtn.createSpan({cls: 'synapse-f-btn-icon'});
		setIcon(scopeIcon, 'folder');
		this.searchScopeBtn.addEventListener('click', () => this.openSearchScopePicker());
		this.updateSearchCwdButton();

		// ── Search input ──
		this.searchInputEl = composer.createEl('textarea', {
			cls: 'synapse-search-input synapse-input',
			attr: {placeholder: 'Describe what you\'re looking for…', rows: '2'},
		});
		this.searchInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.handleSearch();
			}
		});

		// ── Unified toolbar row: mode toggle | [advanced: agent | model | tools] | spacer | search button ──
		const toolbar = composer.createDiv({cls: 'synapse-toolbar synapse-config-toolbar synapse-search-toolbar'});

		// Mode toggle (basic / advanced)
		this.searchModeToggleEl = toolbar.createEl('button', {
			cls: 'synapse-toolbar-btn synapse-search-mode-btn',
			attr: {title: 'Toggle basic/advanced mode', type: 'button'},
		});
		this.searchModeToggleEl.addEventListener('click', () => this.toggleSearchMode());
		this.updateSearchModeToggle();

		// Advanced controls group — hidden in basic mode
		this.searchAdvancedToolbarEl = toolbar.createDiv({cls: 'synapse-search-advanced-group'});

		const addSep = (): HTMLElement =>
			this.searchAdvancedToolbarEl.createSpan({
				cls: 'synapse-toolbar-sep',
				text: '/',
				attr: {'aria-hidden': 'true'},
			});

		addSep();

		// Agent dropdown
		this.searchAgentSelect = this.searchAdvancedToolbarEl.createEl('select', {
			cls: 'synapse-select synapse-agent-select',
		});
		this.searchAgentSelect.addEventListener('change', () => {
			this.searchAgent = this.searchAgentSelect.value;
			this.searchAgentSelect.toggleClass('is-active', this.searchAgent !== '');
			const agent = this.view.view.agents.find(a => a.name === this.searchAgent);
			this.searchAgentSelect.title = agent ? agent.instructions : '';
			// Auto-select agent's preferred model
			const resolvedModel = this.view.view.configToolbar.resolveModelForAgent(agent, this.searchModel || undefined);
			if (resolvedModel && resolvedModel !== this.searchModel) {
				this.searchModel = resolvedModel;
				this.searchModelSelect.value = resolvedModel;
				this.searchModelSelect.toggleClass('is-active', resolvedModel !== '');
			}
			// Apply agent's tools and skills filter for search
			this.applySearchAgentToolsAndSkills(agent);
			// Persist
			this.view.plugin.settings.searchAgent = this.searchAgent;
			void this.view.plugin.saveSettings();
		});

		addSep();

		// Model dropdown
		this.searchModelSelect = this.searchAdvancedToolbarEl.createEl('select', {
			cls: 'synapse-select synapse-model-select',
		});
		this.searchModelSelect.addEventListener('change', () => {
			this.searchModel = this.searchModelSelect.value;
			this.searchModelSelect.toggleClass('is-active', this.searchModel !== '');
		});

		addSep();

		// Tools button
		this.searchToolsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {
			cls: 'synapse-toolbar-btn synapse-tools-btn',
			attr: {title: 'Tools', type: 'button'},
		});
		this.searchToolsBtnEl.addEventListener('click', (e) => this.openSearchToolsMenu(e));
		this.updateSearchToolsBadge();

		// Apply initial visibility
		this.updateSearchAdvancedVisibility();

		// Spacer to push search button to the right
		toolbar.createDiv({cls: 'synapse-toolbar-spacer'});

		// Search button
		this.searchBtnEl = toolbar.createEl('button', {
			cls: 'clickable-icon synapse-search-btn',
			attr: {title: 'Search', type: 'button'},
		});
		setIcon(this.searchBtnEl, 'search');
		this.searchBtnEl.addEventListener('click', () => void this.handleSearch());

		// ── Results area ──
		this.searchResultsEl = wrapper.createDiv({cls: 'synapse-search-results'});
	}

	/** Open the search tab programmatically with scope set to the given folder. */
	openSearchWithScope(folderPath: string): void {
		this.searchWorkingDir = folderPath;
		this.updateSearchCwdButton();
		this.view.view.switchTab('search');
		this.searchInputEl.focus();
	}

	/** Disconnect both search sessions (view unload / mode switch cleanup). */
	async disconnect(): Promise<void> {
		if (this.basicSearchSession) {
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
		}
		if (this.searchSession) {
			try { await this.searchSession.disconnect(); } catch { /* ignore */ }
			this.searchSession = null;
		}
	}

	toggleSearchMode(): void {
		const newMode = this.searchMode === 'basic' ? 'advanced' : 'basic';
		this.view.plugin.settings.searchMode = newMode;
		void this.view.plugin.saveSettings();
		this.updateSearchModeToggle();
		this.updateSearchAdvancedVisibility();
		// Disconnect cached basic session when switching modes
		if (newMode === 'advanced' && this.basicSearchSession) {
			void this.basicSearchSession.disconnect().catch(() => {});
			this.basicSearchSession = null;
		}
	}

	updateSearchModeToggle(): void {
		if (!this.searchModeToggleEl) return;
		this.searchModeToggleEl.empty();
		if (this.searchMode === 'basic') {
			this.searchModeToggleEl.setText('Basic');
			this.searchModeToggleEl.title = 'Basic mode (fast) — click for advanced';
			this.searchModeToggleEl.toggleClass('is-active', false);
		} else {
			this.searchModeToggleEl.setText('Advanced');
			this.searchModeToggleEl.title = 'Advanced mode — click for basic (fast)';
			this.searchModeToggleEl.toggleClass('is-active', true);
		}
	}

	updateSearchAdvancedVisibility(): void {
		if (this.searchAdvancedToolbarEl) {
			this.searchAdvancedToolbarEl.toggleClass('is-hidden', this.searchMode !== 'advanced');
		}
	}

	/** Called from `SynapseView.updateConfigUI()` after agents/skills/models reload. */
	updateSearchConfigUI(): void {
		// Agents
		this.searchAgentSelect.empty();
		const noAgent = this.searchAgentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.view.view.agents) {
			const opt = this.searchAgentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}

		// Restore saved search agent from settings
		const savedAgent = this.view.plugin.settings.searchAgent;
		if (savedAgent && this.view.view.agents.some(a => a.name === savedAgent)) {
			this.searchAgent = savedAgent;
			this.searchAgentSelect.value = savedAgent;
			const selAgent = this.view.view.agents.find(a => a.name === savedAgent);
			this.searchAgentSelect.title = selAgent ? selAgent.instructions : '';
		}
		this.searchAgentSelect.toggleClass('is-active', this.searchAgent !== '');

		// Auto-select agent's preferred model
		const agentConfig = this.view.view.agents.find(a => a.name === this.searchAgent);
		const resolvedModel = this.view.view.configToolbar.resolveModelForAgent(agentConfig, this.searchModel || undefined);
		if (resolvedModel) {
			this.searchModel = resolvedModel;
		}

		// Models
		this.searchModelSelect.empty();
		const defaultOpt = this.searchModelSelect.createEl('option', {text: 'Default model'});
		defaultOpt.value = '';
		for (const model of this.view.view.models) {
			const opt = this.searchModelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.searchModel === '') {
			this.searchModelSelect.value = '';
		} else if (this.searchModel && this.view.view.models.some(m => m.id === this.searchModel)) {
			this.searchModelSelect.value = this.searchModel;
		} else {
			this.searchModel = '';
			this.searchModelSelect.value = '';
		}
		this.searchModelSelect.toggleClass('is-active', this.searchModel !== '');

		// Apply agent's tools and skills filter
		this.applySearchAgentToolsAndSkills(agentConfig);
	}

	applySearchAgentToolsAndSkills(agent?: AgentConfig): void {
		// Skills: undefined = enable all, [] = disable all, [...] = enable listed.
		// This is the agent-declared restriction (AgentConfig.skills), independent
		// from any manual toolbar toggle — all discovered skills are always
		// available unless the selected agent explicitly restricts the set
		// (mirrors applyAgentToolsAndSkills() in configToolbar.ts for chat).
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.searchEnabledSkills = new Set(
				this.view.view.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledSkills = new Set(this.view.view.skills.map(s => s.name));
		}

		this.updateSearchToolsBadge();
	}

	openSearchToolsMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		menu.addSeparator();
		const currentApproval = this.view.plugin.settings.toolApproval;
		menu.addItem(item => {
			item.setTitle('Approval mode');
			const sub: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
			sub.addItem(si => {
				si.setTitle('Allow (auto-approve)')
					.setChecked(currentApproval === 'allow')
					.onClick(async () => {
						this.view.plugin.settings.toolApproval = 'allow';
						await this.view.plugin.saveSettings();
						this.updateSearchToolsBadge();
						this.view.view.configToolbar.updateToolsBadge();
					});
			});
			sub.addItem(si => {
				si.setTitle('Ask (require approval)')
					.setChecked(currentApproval === 'ask')
					.onClick(async () => {
						this.view.plugin.settings.toolApproval = 'ask';
						await this.view.plugin.saveSettings();
						this.updateSearchToolsBadge();
						this.view.view.configToolbar.updateToolsBadge();
					});
			});
		});
		menu.showAtMouseEvent(e);
	}

	updateSearchToolsBadge(): void {
		if (!this.searchToolsBtnEl) return;
		const approval = this.view.plugin.settings.toolApproval;
		const label = approval === 'allow' ? 'Allow' : 'Ask';
		this.searchToolsBtnEl.setText(label);
		this.searchToolsBtnEl.toggleClass('is-active', approval === 'allow');
		this.searchToolsBtnEl.setAttribute('title', `Tools (${approval === 'allow' ? 'auto-approve' : 'ask before running'})`);
	}

	openSearchScopePicker(): void {
		new FolderTreeModal(this.view.app, this.searchWorkingDir, (folder) => {
			this.searchWorkingDir = folder.path;
			this.updateSearchCwdButton();
		}).open();
	}

	updateSearchCwdButton(): void {
		if (!this.searchCwdBtnEl) return;
		const vaultName = this.view.app.vault.getName();
		const label = this.searchWorkingDir
			? `Search scope: ${vaultName}/${this.searchWorkingDir}`
			: `Search scope: ${vaultName} (entire vault)`;
		this.searchCwdBtnEl.setAttribute('title', label);
		this.searchScopeBtn?.setAttribute('title', label);
		const hasFolder = Boolean(this.searchWorkingDir && this.searchWorkingDir !== '' && this.searchWorkingDir !== '/');
		this.searchCwdBtnEl.toggleClass('is-active', hasFolder);
		this.searchScopeBtn?.toggleClass('is-active', hasFolder);
		const folderName = this.searchWorkingDir ? (this.searchWorkingDir.split('/').pop() || this.searchWorkingDir) : '';
		const truncated = folderName.length > CWD_LABEL_MAX_CHARS
			? `${folderName.slice(0, CWD_LABEL_MAX_CHARS - 1)}…`
			: folderName;
		this.searchCwdBtnEl.setText(truncated ? truncated : 'Dir');
	}

	buildSearchSessionConfig(): SessionConfig {
		// Self-improve detection hint (static body — issue #201) + resilience hint for
		// search sessions. The "Current agent" line moved out of this hint's return value
		// (it's volatile) and is delivered per-turn in the search prompt instead — see
		// `handleAdvancedSearch()`'s `buildCurrentAgentLine()` call.
		const selfImproveBlock = buildSelfImproveHint();
		const resilienceBlock = buildResilienceHint();

		return {
			model: this.searchModel || undefined,
			agent: this.searchAgent || this.view.plugin.settings.featureAgents?.search || undefined,
			permissionMode: this.view.plugin.settings.toolApproval === 'allow' ? 'bypassPermissions' as const : 'default' as const,
			...(this.view.plugin.settings.toolApproval === 'allow' ? {allowDangerouslySkipPermissions: true} : {}),
			cwd: this.getSearchWorkingDirectory(),
			plugins: getSynapsePluginConfig(this.view.app),
			skills: Array.from(this.searchEnabledSkills),
			// Search is read-only: expose only file-exploration tools. Enabled skills
			// remain available (the `skills` option enables the Skill tool itself).
			tools: SEARCH_TOOLS,
			maxTurns: 40,
			// Append to the Claude Code preset — a plain string would replace the
			// default system prompt and the model stops using its tools.
			systemPrompt: {type: 'preset', preset: 'claude_code', append: (resilienceBlock + selfImproveBlock).trim()},
		};
	}

	async handleSearch(): Promise<void> {
		if (this.isSearching) {
			// Cancel in-progress search
			if (this.searchAbortController) {
				this.searchAbortController.abort();
				this.searchAbortController = null;
			}
			const session = this.searchMode === 'basic' ? this.basicSearchSession : this.searchSession;
			if (session) {
				try { await session.abort(); } catch { /* ignore */ }
			}
			if (this.searchMode === 'advanced' && this.searchSession) {
				try { await this.searchSession.disconnect(); } catch { /* ignore */ }
				this.searchSession = null;
			}
			this.isSearching = false;
			this.updateSearchButton();
			return;
		}

		const query = this.searchInputEl.value.trim();
		if (!query) return;

		if (!this.view.plugin.agentService) {
			new Notice('Synapse is not configured.');
			return;
		}

		this.isSearching = true;
		this.searchAbortController = new AbortController();
		this.updateSearchButton();
		this.searchResultsEl.empty();
		const loadingEl = this.searchResultsEl.createDiv({cls: 'synapse-search-loading'});
		loadingEl.createSpan({cls: 'synapse-search-loading-text', text: 'Searching vault…'});
		loadingEl.createSpan({cls: 'synapse-search-loading-bar'});

		try {
			if (this.searchMode === 'basic') {
				await this.handleBasicSearch(query);
			} else {
				await this.handleAdvancedSearch(query);
			}
		} catch (e) {
			if (this.isSearching) {
				this.searchResultsEl.empty();
				this.searchResultsEl.createDiv({cls: 'synapse-search-empty', text: `Search failed: ${String(e)}`});
			}
		} finally {
			this.isSearching = false;
			this.searchAbortController = null;
			this.updateSearchButton();
		}
	}

	private async handleBasicSearch(query: string): Promise<void> {
		const searchPrompt = buildSearchPrompt(query);

		const timeoutMs = getAdaptiveTimeout(this.view.app, this.getSearchWorkingDirectory(), this.view.plugin.settings.providerRequestTimeout);

		// Read-only file tools + enough turns to actually explore the vault.
		// (tools: [] with maxTurns: 1 made every search fail with
		// "Reached maximum number of turns (1)".)
		// `app` + `autoApproveReadOnlyTools` (#167) makes this reachable on a local model too —
		// see the doc comment on `autoApproveReadOnlyTools` in `agentService.ts` for why an
		// always-allow handler is safe here specifically (tools is restricted to SEARCH_TOOLS).
		const {content} = await this.view.plugin.agentService!.inlineChat({
			prompt: searchPrompt,
			agent: this.view.plugin.settings.featureAgents?.search || this.view.plugin.settings.searchAgent || undefined,
			cwd: this.getSearchWorkingDirectory(),
			permissionMode: 'default',
			tools: SEARCH_TOOLS,
			maxTurns: 20,
			timeoutMs,
			app: this.view.app,
			canUseTool: autoApproveReadOnlyTools,
			...(this.searchAbortController ? {abortController: this.searchAbortController} : {}),
		});
		this.renderSearchResults(content || '', query);
	}

	private async handleAdvancedSearch(query: string): Promise<void> {
		const sessionConfig = this.buildSearchSessionConfig();
		// Current agent moved out of the (session-stable) self-improve hint in
		// `buildSearchSessionConfig()` — deliver it per-turn in the prompt instead (issue #201).
		const searchPrompt = buildSearchPrompt(query) + buildCurrentAgentLine(this.searchAgent || 'Auto');

		const timeoutMs = getAdaptiveTimeout(this.view.app, this.getSearchWorkingDirectory(), this.view.plugin.settings.providerRequestTimeout);

		// `app` + `autoApproveReadOnlyTools` (#167) — see the doc comment on
		// `autoApproveReadOnlyTools` in `agentService.ts`. Safe here because
		// `buildSearchSessionConfig()` always sets `tools: SEARCH_TOOLS` (read-only).
		const {content, sessionId} = await this.view.plugin.agentService!.inlineChat({
			prompt: searchPrompt,
			...sessionConfig,
			timeoutMs,
			app: this.view.app,
			canUseTool: autoApproveReadOnlyTools,
			...(this.searchAbortController ? {abortController: this.searchAbortController} : {}),
		});

		// Name the session (skip if the query never got an id, e.g. aborted)
		if (!sessionId) {
			this.renderSearchResults(content || '', query);
			return;
		}
		const agentLabel = this.searchAgent || 'Search';
		const truncated = query.length > 40 ? query.slice(0, 40) + '...' : query;
		this.view.view.sessionNames[sessionId] = `[search] ${agentLabel}: ${truncated}`;
		this.view.view.saveSessionNames();

		// Add to session list
		if (!this.view.view.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.view.view.sessionList.unshift({
				sessionId,
				summary: '',
				lastModified: now.getTime(),
			});
		}
		this.view.view.sidebar.renderSessionList();

		this.renderSearchResults(content || '', query);
	}

	renderSearchResults(content: string, query?: string): void {
		this.searchResultsEl.empty();

		// Try to parse JSON array from the response
		let results: Array<{file?: string; path?: string; folder: string; reason: string}> = [];
		try {
			// Strip markdown fences if present
			const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
			const parsed: unknown = JSON.parse(cleaned);
			// Handle both single object and array responses
			results = (Array.isArray(parsed) ? parsed : [parsed]) as typeof results;
		} catch {
			// If not valid JSON, show the raw response
			this.searchResultsEl.createDiv({cls: 'synapse-search-empty', text: content || 'No results found'});
			return;
		}

		if (!Array.isArray(results) || results.length === 0) {
			this.searchResultsEl.createDiv({cls: 'synapse-search-empty', text: 'No results found'});
			return;
		}

		for (const result of results) {
			const item = this.searchResultsEl.createDiv({cls: 'synapse-search-result'});

			const fileRow = item.createDiv({cls: 'synapse-search-result-file'});
			const fileIcon = fileRow.createSpan({cls: 'synapse-search-result-icon'});
			setIcon(fileIcon, 'file-text');
			const filePath = (result.file || result.path || '').replace(/^\/+/, '');
			const fileName = filePath.split('/').pop() || filePath || 'Unknown';
			const fileLink = fileRow.createSpan({cls: 'synapse-search-result-name', text: fileName});

			fileLink.addEventListener('click', () => {
				if (!filePath) return;
				const resolved = this.view.app.vault.getAbstractFileByPath(filePath)
					?? (result.folder ? this.view.app.vault.getAbstractFileByPath(result.folder + '/' + filePath) : null);
				if (resolved instanceof TFile) {
					void this.view.app.workspace.openLinkText(resolved.path, '', false);
				} else {
					// Fallback: let Obsidian try to resolve the link
					void this.view.app.workspace.openLinkText(filePath, '', false);
				}
			});

			if (result.folder) {
				fileRow.createSpan({cls: 'synapse-search-result-folder', text: result.folder});
			}

			if (result.reason) {
				const reasonEl = item.createDiv({cls: 'synapse-search-result-reason'});
				highlightQueryTerms(reasonEl, result.reason, query);
			}
		}
	}

	updateSearchButton(): void {
		this.searchBtnEl.empty();
		if (this.isSearching) {
			setIcon(this.searchBtnEl, 'square');
			this.searchBtnEl.title = 'Cancel search';
			this.searchBtnEl.addClass('is-searching');
		} else {
			setIcon(this.searchBtnEl, 'search');
			this.searchBtnEl.title = 'Search';
			this.searchBtnEl.removeClass('is-searching');
		}
	}
}