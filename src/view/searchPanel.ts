import {Menu, Notice, TFile, normalizePath, setIcon} from 'obsidian';
import type {SynapseView} from '../synapseView';
import type {SessionConfig, SessionMetadata, CustomAgentConfig} from '../copilot';
import {toCustomAgentConfig} from '../copilot';
import type {AgentConfig} from '../types';
import {SYNAPSE_FOLDER} from '../settings';
import {FolderTreeModal} from '../modals';
import {buildSelfImproveHint, getAdaptiveTimeout} from './sessionConfig';

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
		openSearchSkillsMenu(e: MouseEvent): void;
		openSearchToolsMenu(e: MouseEvent): void;
		updateSearchSkillsBadge(): void;
		updateSearchToolsBadge(): void;
		openSearchScopePicker(): void;
		updateSearchCwdButton(): void;
		getSearchWorkingDirectory(): string;
		buildSearchSessionConfig(): SessionConfig;
		handleSearch(): Promise<void>;
		handleBasicSearch(query: string): Promise<void>;
		handleAdvancedSearch(query: string): Promise<void>;
		buildBasicSearchSessionConfig(): SessionConfig;
		renderSearchResults(content: string): void;
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

		// Skills button
		this.searchSkillsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon synapse-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.searchSkillsBtnEl, 'wand-2');
		this.searchSkillsBtnEl.addEventListener('click', (e) => this.openSearchSkillsMenu(e));

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
		for (const model of this.models) {
			const opt = this.searchModelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.searchModel && this.models.some(m => m.id === this.searchModel)) {
			this.searchModelSelect.value = this.searchModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.searchModel = this.models[0].id;
			this.searchModelSelect.value = this.searchModel;
		}

		// Apply agent's tools and skills filter
		this.applySearchAgentToolsAndSkills(agentConfig);
	};

	proto.applySearchAgentToolsAndSkills = function (this: SynapseView, agent?: AgentConfig): void {
		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.searchEnabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSearchSkillsBadge();
		this.updateSearchToolsBadge();
	};

	proto.openSearchSkillsMenu = function (this: SynapseView, e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.searchEnabledSkills.has(skill.name))
						.onClick(() => {
							if (this.searchEnabledSkills.has(skill.name)) {
								this.searchEnabledSkills.delete(skill.name);
							} else {
								this.searchEnabledSkills.add(skill.name);
							}
							this.updateSearchSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	};

	proto.openSearchToolsMenu = function (this: SynapseView, e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		menu.showAtMouseEvent(e);
	};

	proto.updateSearchSkillsBadge = function (this: SynapseView): void {
		const count = this.searchEnabledSkills.size;
		this.searchSkillsBtnEl.toggleClass('is-active', count > 0);
		this.searchSkillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
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
		const basePath = this.getVaultBasePath();

		// Skills
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, normalizePath(`${SYNAPSE_FOLDER}/skills`)].join('/'));
		}
		const _disabledSkills = this.skills
			.filter(s => !this.searchEnabledSkills.has(s.name))
			.map(s => s.name);

		// Custom agents — only the selected search agent, or all if none selected
		const agentPool = this.searchAgent
			? this.agents.filter(a => a.name === this.searchAgent)
			: this.agents;
		const agents: Record<string, CustomAgentConfig> = {};
		for (const a of agentPool) {
			agents[a.name] = toCustomAgentConfig(a);
		}

		// Self-improve detection hint for search sessions
		const selfImproveBlock = buildSelfImproveHint(this.searchAgent || 'Auto');

		return {
			model: this.searchModel || undefined,
			permissionMode: this.plugin.settings.toolApproval === 'allow' ? 'bypassPermissions' as const : 'default' as const,
			...(this.plugin.settings.toolApproval === 'allow' ? {allowDangerouslySkipPermissions: true} : {}),
			cwd: this.getSearchWorkingDirectory(),
			...(Object.keys(agents).length > 0 ? {agents} : {}),
			systemPrompt: selfImproveBlock.trim(),
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

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured.');
			return;
		}

		this.isSearching = true;
		this.searchAbortController = new AbortController();
		this.updateSearchButton();
		this.searchResultsEl.empty();
		this.searchResultsEl.createDiv({cls: 'synapse-search-loading', text: 'Searching…'});

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
		const searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;

		const timeoutMs = getAdaptiveTimeout(this.app, this.getSearchWorkingDirectory(), this.plugin.settings.providerRequestTimeout);

		const {content} = await this.plugin.copilot!.inlineChat({
			prompt: searchPrompt,
			agent: this.plugin.settings.featureAgents?.search || this.plugin.settings.searchAgent || 'General',
			cwd: this.getSearchWorkingDirectory(),
			permissionMode: 'plan',
			tools: [],
			maxTurns: 1,
			timeoutMs,
			...(this.searchAbortController ? {abortController: this.searchAbortController} : {}),
		});
		this.renderSearchResults(content || '');
	};

	proto.handleAdvancedSearch = async function (this: SynapseView, query: string): Promise<void> {
		const sessionConfig = this.buildSearchSessionConfig();
		const searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;

		const timeoutMs = getAdaptiveTimeout(this.app, this.getSearchWorkingDirectory(), this.plugin.settings.providerRequestTimeout);

		const {content, sessionId} = await this.plugin.copilot!.inlineChat({
			prompt: searchPrompt,
			...sessionConfig,
			timeoutMs,
			...(this.searchAbortController ? {abortController: this.searchAbortController} : {}),
		});

		// Name the session
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
			} as SessionMetadata);
		}
		this.renderSessionList();

		this.renderSearchResults(content || '');
	};

	proto.buildBasicSearchSessionConfig = function (this: SynapseView): SessionConfig {
		return {
			agent: this.plugin.settings.featureAgents?.search || this.plugin.settings.searchAgent || 'General',
			permissionMode: 'plan',
			cwd: this.getSearchWorkingDirectory(),
			tools: [],
		};
	};

	proto.renderSearchResults = function (this: SynapseView, content: string): void {
		this.searchResultsEl.empty();

		// Try to parse JSON array from the response
		let results: Array<{file?: string; path?: string; folder: string; reason: string}> = [];
		try {
			// Strip markdown fences if present
			const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
			const parsed = JSON.parse(cleaned);
			// Handle both single object and array responses
			results = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			// If not valid JSON, show the raw response
			this.searchResultsEl.createDiv({cls: 'synapse-search-empty', text: content || 'No results found.'});
			return;
		}

		if (!Array.isArray(results) || results.length === 0) {
			this.searchResultsEl.createDiv({cls: 'synapse-search-empty', text: 'No results found.'});
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
				item.createDiv({cls: 'synapse-search-result-reason', text: result.reason});
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
