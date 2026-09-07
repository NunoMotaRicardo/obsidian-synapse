import {Menu, Notice, TFile, normalizePath, setIcon} from 'obsidian';
import type {SynapseView} from '../synapseView';
import {autoApproveReadOnlyTools, type SessionConfig} from '../agentService';
import type {AgentConfig} from '../types';
import {FolderTreeModal} from '../modals';
import {buildCurrentAgentLine, buildResilienceHint, buildSelfImproveHint, getAdaptiveTimeout} from './sessionConfig';
import {getSynapsePluginConfig} from '../vaultPaths';

/** Read-only file tools for vault search — no write/exec access needed. */
const SEARCH_TOOLS = ['Read', 'Glob', 'Grep'];

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

declare module '../synapseView' {
	interface SynapseView {
		searchAbortController?: AbortController | null;
		buildSearchPanel(parent: HTMLElement): void;
		readonly searchMode: 'basic' | 'advanced';
		toggleSearchMode(): void;
		updateSearchModeToggle(): void;
		updateSearchAdvancedVisibility(): void;
		updateSearchConfigUI(): void;
		applySearchAgentToolsAndSkills(agent?: AgentConfig): void;
		openSearchToolsMenu(e: MouseEvent): void;
		updateSearchToolsBadge(): void;
		openSearchScopePicker(): void;
		updateSearchCwdButton(): void;
		getSearchWorkingDirectory(): string;
		buildSearchSessionConfig(): SessionConfig;
		handleSearch(): Promise<void>;
		handleBasicSearch(query: string): Promise<void>;
		handleAdvancedSearch(query: string): Promise<void>;
		renderSearchResults(content: string, query?: string): void;
		updateSearchButton(): void;
	}
}

export function installSearchPanel(ViewClass: { prototype: unknown }): void {
	const proto = ViewClass.prototype as SynapseView;

	proto.buildSearchPanel = function (this: SynapseView, parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'synapse-search-wrapper'});

		// ── Toolbar row: scope | mode toggle | [advanced: agent | model | skills | tools] ──
		const toolbar = wrapper.createDiv({cls: 'synapse-toolbar synapse-search-toolbar'});

		// Search scope (folder picker) — always visible
		this.searchCwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon synapse-icon-btn', attr: {title: 'Search scope'}});
		setIcon(this.searchCwdBtnEl, 'folder');
		this.searchCwdBtnEl.addEventListener('click', () => this.openSearchScopePicker());
		this.updateSearchCwdButton();

		// Mode toggle (basic / advanced)
		this.searchModeToggleEl = toolbar.createEl('button', {cls: 'clickable-icon synapse-icon-btn', attr: {title: 'Toggle basic/advanced mode'}});
		this.searchModeToggleEl.addEventListener('click', () => this.toggleSearchMode());
		this.updateSearchModeToggle();

		// Advanced controls group — hidden in basic mode
		this.searchAdvancedToolbarEl = toolbar.createDiv({cls: 'synapse-search-advanced-group'});

		// Agent dropdown
		const agentGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'synapse-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'synapse-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.searchAgentSelect = agentGroup.createEl('select', {cls: 'synapse-select'});
		this.searchAgentSelect.addEventListener('change', () => {
			this.searchAgent = this.searchAgentSelect.value;
			const agent = this.agents.find(a => a.name === this.searchAgent);
			this.searchAgentSelect.title = agent ? agent.instructions : '';
			// Auto-select agent's preferred model
			const resolvedModel = this.resolveModelForAgent(agent, this.searchModel || undefined);
			if (resolvedModel && resolvedModel !== this.searchModel) {
				this.searchModel = resolvedModel;
				this.searchModelSelect.value = resolvedModel;
			}
			// Apply agent's tools and skills filter for search
			this.applySearchAgentToolsAndSkills(agent);
			// Persist
			this.plugin.settings.searchAgent = this.searchAgent;
			void this.plugin.saveSettings();
		});

		// Model dropdown
		const modelGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'synapse-toolbar-group'});
		const modelIcon = modelGroup.createSpan({cls: 'synapse-toolbar-icon'});
		setIcon(modelIcon, 'cpu');
		this.searchModelSelect = modelGroup.createEl('select', {cls: 'synapse-select synapse-model-select'});
		this.searchModelSelect.addEventListener('change', () => {
			this.searchModel = this.searchModelSelect.value;
		});

		// Tools button
		this.searchToolsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon synapse-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.searchToolsBtnEl, 'plug');
		this.searchToolsBtnEl.addEventListener('click', (e) => this.openSearchToolsMenu(e));

		// Apply initial visibility
		this.updateSearchAdvancedVisibility();

		// ── Search input + button ──
		const inputRow = wrapper.createDiv({cls: 'synapse-search-input-row'});
		this.searchInputEl = inputRow.createEl('textarea', {
			cls: 'synapse-search-input',
			attr: {placeholder: 'Describe what you\'re looking for…', rows: '2'},
		});
		this.searchInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.handleSearch();
			}
		});

		this.searchBtnEl = inputRow.createEl('button', {cls: 'synapse-search-btn', attr: {title: 'Search'}});
		setIcon(this.searchBtnEl, 'search');
		this.searchBtnEl.addEventListener('click', () => void this.handleSearch());

		// ── Results area ──
		this.searchResultsEl = wrapper.createDiv({cls: 'synapse-search-results'});
	};

	Object.defineProperty(proto, 'searchMode', {
		get(this: SynapseView) { return this.plugin.settings.searchMode; },
		configurable: true,
	});

	proto.toggleSearchMode = function (this: SynapseView): void {
		const newMode = this.searchMode === 'basic' ? 'advanced' : 'basic';
		this.plugin.settings.searchMode = newMode;
		void this.plugin.saveSettings();
		this.updateSearchModeToggle();
		this.updateSearchAdvancedVisibility();
		// Disconnect cached basic session when switching modes
		if (newMode === 'advanced' && this.basicSearchSession) {
			void this.basicSearchSession.disconnect().catch(() => {});
			this.basicSearchSession = null;
		}
	};

	proto.updateSearchModeToggle = function (this: SynapseView): void {
		this.searchModeToggleEl.empty();
		if (this.searchMode === 'basic') {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Basic mode (fast) — click for advanced';
		} else {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Advanced mode — click for basic (fast)';
		}
		this.searchModeToggleEl.toggleClass('is-active', this.searchMode === 'advanced');
	};

	proto.updateSearchAdvancedVisibility = function (this: SynapseView): void {
		this.searchAdvancedToolbarEl.toggleClass('is-hidden', this.searchMode !== 'advanced');
	};

	proto.updateSearchConfigUI = function (this: SynapseView): void {
		// Agents
		this.searchAgentSelect.empty();
		const noAgent = this.searchAgentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.searchAgentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}

		// Restore saved search agent from settings
		const savedAgent = this.plugin.settings.searchAgent;
		if (savedAgent && this.agents.some(a => a.name === savedAgent)) {
			this.searchAgent = savedAgent;
			this.searchAgentSelect.value = savedAgent;
			const selAgent = this.agents.find(a => a.name === savedAgent);
			this.searchAgentSelect.title = selAgent ? selAgent.instructions : '';
		}

		// Auto-select agent's preferred model
		const agentConfig = this.agents.find(a => a.name === this.searchAgent);
		const resolvedModel = this.resolveModelForAgent(agentConfig, this.searchModel || undefined);
		if (resolvedModel) {
			this.searchModel = resolvedModel;
		}

		// Models
		this.searchModelSelect.empty();
		const defaultOpt = this.searchModelSelect.createEl('option', {text: 'Default model'});
		defaultOpt.value = '';
		for (const model of this.models) {
			const opt = this.searchModelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.searchModel === '') {
			this.searchModelSelect.value = '';
		} else if (this.searchModel && this.models.some(m => m.id === this.searchModel)) {
			this.searchModelSelect.value = this.searchModel;
		} else {
			this.searchModel = '';
			this.searchModelSelect.value = '';
		}

		// Apply agent's tools and skills filter
		this.applySearchAgentToolsAndSkills(agentConfig);
	};

	proto.applySearchAgentToolsAndSkills = function (this: SynapseView, agent?: AgentConfig): void {
		// Skills: undefined = enable all, [] = disable all, [...] = enable listed.
		// This is the agent-declared restriction (AgentConfig.skills), independent
		// from any manual toolbar toggle — all discovered skills are always
		// available unless the selected agent explicitly restricts the set
		// (mirrors applyAgentToolsAndSkills() in configToolbar.ts for chat).
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.searchEnabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSearchToolsBadge();
	};

	proto.openSearchToolsMenu = function (this: SynapseView, e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		menu.showAtMouseEvent(e);
	};

	proto.updateSearchToolsBadge = function (this: SynapseView): void {
		// MCP is now SDK-native; badge always shows inactive
		this.searchToolsBtnEl.toggleClass('is-active', false);
		this.searchToolsBtnEl.setAttribute('title', 'Tools');
	};

	proto.openSearchScopePicker = function (this: SynapseView): void {
		new FolderTreeModal(this.app, this.searchWorkingDir, (folder) => {
			this.searchWorkingDir = folder.path;
			this.updateSearchCwdButton();
		}).open();
	};

	proto.updateSearchCwdButton = function (this: SynapseView): void {
		const vaultName = this.app.vault.getName();
		const label = this.searchWorkingDir
			? `Search scope: ${vaultName}/${this.searchWorkingDir}`
			: `Search scope: ${vaultName} (entire vault)`;
		this.searchCwdBtnEl.setAttribute('title', label);
		this.searchCwdBtnEl.toggleClass('is-active', !!this.searchWorkingDir);
	};

	proto.getSearchWorkingDirectory = function (this: SynapseView): string {
		const base = this.getVaultBasePath();
		if (!this.searchWorkingDir) return base;
		return base + '/' + normalizePath(this.searchWorkingDir);
	};

	proto.buildSearchSessionConfig = function (this: SynapseView): SessionConfig {
		// Self-improve detection hint (static body — issue #201) + resilience hint for
		// search sessions. The "Current agent" line moved out of this hint's return value
		// (it's volatile) and is delivered per-turn in the search prompt instead — see
		// `handleAdvancedSearch()`'s `buildCurrentAgentLine()` call.
		const selfImproveBlock = buildSelfImproveHint();
		const resilienceBlock = buildResilienceHint();

		return {
			model: this.searchModel || undefined,
			agent: this.searchAgent || this.plugin.settings.featureAgents?.search || undefined,
			permissionMode: this.plugin.settings.toolApproval === 'allow' ? 'bypassPermissions' as const : 'default' as const,
			...(this.plugin.settings.toolApproval === 'allow' ? {allowDangerouslySkipPermissions: true} : {}),
			cwd: this.getSearchWorkingDirectory(),
			plugins: getSynapsePluginConfig(this.app),
			skills: Array.from(this.searchEnabledSkills),
			// Search is read-only: expose only file-exploration tools. Enabled skills
			// remain available (the `skills` option enables the Skill tool itself).
			tools: SEARCH_TOOLS,
			maxTurns: 40,
			// Append to the Claude Code preset — a plain string would replace the
			// default system prompt and the model stops using its tools.
			systemPrompt: {type: 'preset', preset: 'claude_code', append: (resilienceBlock + selfImproveBlock).trim()},
		};
	};

	proto.handleSearch = async function (this: SynapseView): Promise<void> {
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

		if (!this.plugin.agentService) {
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
	};

	proto.handleBasicSearch = async function (this: SynapseView, query: string): Promise<void> {
		const searchPrompt = buildSearchPrompt(query);

		const timeoutMs = getAdaptiveTimeout(this.app, this.getSearchWorkingDirectory(), this.plugin.settings.providerRequestTimeout);

		// Read-only file tools + enough turns to actually explore the vault.
		// (tools: [] with maxTurns: 1 made every search fail with
		// "Reached maximum number of turns (1)".)
		// `app` + `autoApproveReadOnlyTools` (#167) makes this reachable on a local model too —
		// see the doc comment on `autoApproveReadOnlyTools` in `agentService.ts` for why an
		// always-allow handler is safe here specifically (tools is restricted to SEARCH_TOOLS).
		const {content} = await this.plugin.agentService!.inlineChat({
			prompt: searchPrompt,
			agent: this.plugin.settings.featureAgents?.search || this.plugin.settings.searchAgent || undefined,
			cwd: this.getSearchWorkingDirectory(),
			permissionMode: 'default',
			tools: SEARCH_TOOLS,
			maxTurns: 20,
			timeoutMs,
			app: this.app,
			canUseTool: autoApproveReadOnlyTools,
			...(this.searchAbortController ? {abortController: this.searchAbortController} : {}),
		});
		this.renderSearchResults(content || '', query);
	};

	proto.handleAdvancedSearch = async function (this: SynapseView, query: string): Promise<void> {
		const sessionConfig = this.buildSearchSessionConfig();
		// Current agent moved out of the (session-stable) self-improve hint in
		// `buildSearchSessionConfig()` — deliver it per-turn in the prompt instead (issue #201).
		const searchPrompt = buildSearchPrompt(query) + buildCurrentAgentLine(this.searchAgent || 'Auto');

		const timeoutMs = getAdaptiveTimeout(this.app, this.getSearchWorkingDirectory(), this.plugin.settings.providerRequestTimeout);

		// `app` + `autoApproveReadOnlyTools` (#167) — see the doc comment on
		// `autoApproveReadOnlyTools` in `agentService.ts`. Safe here because
		// `buildSearchSessionConfig()` always sets `tools: SEARCH_TOOLS` (read-only).
		const {content, sessionId} = await this.plugin.agentService!.inlineChat({
			prompt: searchPrompt,
			...sessionConfig,
			timeoutMs,
			app: this.app,
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
		this.sessionNames[sessionId] = `[search] ${agentLabel}: ${truncated}`;
		this.saveSessionNames();

		// Add to session list
		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				summary: '',
				lastModified: now.getTime(),
			});
		}
		this.renderSessionList();

		this.renderSearchResults(content || '', query);
	};

	proto.renderSearchResults = function (this: SynapseView, content: string, query?: string): void {
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
				const resolved = this.app.vault.getAbstractFileByPath(filePath)
					?? (result.folder ? this.app.vault.getAbstractFileByPath(result.folder + '/' + filePath) : null);
				if (resolved instanceof TFile) {
					void this.app.workspace.openLinkText(resolved.path, '', false);
				} else {
					// Fallback: let Obsidian try to resolve the link
					void this.app.workspace.openLinkText(filePath, '', false);
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
	};

	proto.updateSearchButton = function (this: SynapseView): void {
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
	};
}
