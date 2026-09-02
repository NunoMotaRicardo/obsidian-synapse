import {Menu, setIcon} from 'obsidian';
import type {SynapseView} from '../synapseView';
import type {ModelInfo} from '../agentService';
import type {AgentConfig} from '../types';
import {FolderTreeModal} from '../modals';
import {EditModal} from '../modals/editModal';
import {setDebugEnabled} from '../debug';
import {resolveModelForAgent} from './sessionConfig';

/** Human label for a reasoning-effort level. 'none' reads as "Off". */
function effortLabel(level: string): string {
	if (level === 'none') return 'Off';
	return level.charAt(0).toUpperCase() + level.slice(1);
}

declare module '../synapseView' {
	interface SynapseView {
		buildConfigToolbar(parent: HTMLElement): void;
		populateModelSelect(): void;
		getSelectedModelInfo(): ModelInfo | undefined;
		openReasoningMenu(e: MouseEvent): void;
		updateReasoningBadge(): void;
		applyReasoningToSession(): void;
		openToolsMenu(e: MouseEvent): void;
		selectAgent(agentName: string): void;
		applyAgentToolsAndSkills(agent?: AgentConfig): void;
		updateToolsBadge(): void;
		openCwdPicker(): void;
		updateCwdButton(): void;
		openEditFromChat(): void;
		resolveModelForAgent(agent: AgentConfig | undefined, fallback: string | undefined): string | undefined;
	}
}

export function installConfigToolbar(ViewClass: { prototype: unknown }): void {
	const proto = ViewClass.prototype as SynapseView;

	proto.buildConfigToolbar = function(parent: HTMLElement): void {
		const toolbar = parent.createDiv({cls: 'synapse-toolbar'});

		// New conversation button
		const newChatBtn = toolbar.createEl('button', {cls: 'clickable-icon synapse-icon-btn', attr: {title: 'New conversation'}});
		setIcon(newChatBtn, 'plus');
		newChatBtn.addEventListener('click', () => void this.newConversation());

		// Agent dropdown
		const agentGroup = toolbar.createDiv({cls: 'synapse-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'synapse-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.agentSelect = agentGroup.createEl('select', {cls: 'synapse-select'});
		this.agentSelect.addEventListener('change', () => {
			this.selectAgent(this.agentSelect.value);
		});

		// Model dropdown
		const modelGroup = toolbar.createDiv({cls: 'synapse-toolbar-group'});
		this.modelIconEl = modelGroup.createSpan({cls: 'synapse-toolbar-icon clickable-icon'});
		setIcon(this.modelIconEl, 'cpu');
		this.modelIconEl.addEventListener('click', (e) => { e.stopPropagation(); this.openReasoningMenu(e); });
		this.modelSelect = modelGroup.createEl('select', {cls: 'synapse-select synapse-model-select'});
		this.modelSelect.addEventListener('change', () => {
			const newModel = this.modelSelect.value;
			this.selectedModel = newModel;
			// Reset any reasoning effort the new model doesn't support first, then
			// carry the (now-valid) effort + summary into the mid-session switch.
			this.updateReasoningBadge();
			this.applyReasoningToSession();
		});

		// Tools button
		this.toolsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon synapse-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.toolsBtnEl, 'plug');
		this.toolsBtnEl.addEventListener('click', (e) => this.openToolsMenu(e));

		// Working directory button
		this.cwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon synapse-icon-btn', attr: {title: 'Working directory'}});
		setIcon(this.cwdBtnEl, 'hard-drive-download');
		this.cwdBtnEl.addEventListener('click', () => this.openCwdPicker());
		this.updateCwdButton();

		// Spacer to push debug toggle to the right
		toolbar.createDiv({cls: 'synapse-toolbar-spacer'});

		// Debug toggle
		this.debugBtnEl = toolbar.createDiv({cls: 'synapse-debug-toggle', attr: {title: 'Show tool & token details'}});
		const debugIcon = this.debugBtnEl.createSpan({cls: 'synapse-debug-icon'});
		setIcon(debugIcon, 'bug');
		const debugCheck = this.debugBtnEl.createEl('input', {type: 'checkbox', cls: 'synapse-debug-checkbox'});
		debugCheck.checked = this.showDebugInfo;
		debugCheck.addEventListener('change', () => {
			this.showDebugInfo = debugCheck.checked;
			setDebugEnabled(this.showDebugInfo);
			this.chatContainer.toggleClass('synapse-hide-debug', !this.showDebugInfo);
		});
		this.debugBtnEl.addEventListener('click', (e) => {
			if (e.target !== debugCheck) {
				debugCheck.checked = !debugCheck.checked;
				debugCheck.dispatchEvent(new Event('change'));
			}
		});
	};

	proto.populateModelSelect = function(): void {
		this.modelSelect.empty();
		const defaultOpt = this.modelSelect.createEl('option', {text: 'Default model'});
		defaultOpt.value = '';
		for (const model of this.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
	};

	proto.getSelectedModelInfo = function(): ModelInfo | undefined {
		return this.models.find(m => m.id === this.selectedModel);
	};

	proto.openReasoningMenu = function(e: MouseEvent): void {
		const model = this.getSelectedModelInfo();
		// The SDK narrows supportedReasoningEfforts to its ReasoningEffort union, but
		// models report values beyond it (e.g. 'max', 'none'); treat them as strings.
		const supported = model?.capabilities?.supportedReasoningEfforts;
		const supportsReasoning = !!model?.capabilities?.supports?.reasoningEffort && !!supported && supported.length > 0;
		const menu = new Menu();

		if (this.selectedModel === '') {
			menu.addItem(item => item.setTitle('Default model (capabilities unknown)').setDisabled(true));
		} else if (supportsReasoning) {
			const current = this.plugin.settings.reasoningEffort;
			for (const level of supported) {
				menu.addItem(item => {
					item.setTitle(effortLabel(level))
						.setChecked(level === current)
						.onClick(() => {
							// Toggle back to model default if the active level is re-selected.
							this.plugin.settings.reasoningEffort = level === current ? '' : level;
							void this.plugin.saveSettings();
							this.applyReasoningToSession();
							this.updateReasoningBadge();
						});
				});
			}
		} else {
			menu.addItem(item => item.setTitle('Model does not support reasoning effort').setDisabled(true));
		}

		// Infinite sessions toggle — controls automatic context compaction.
		menu.addSeparator();
		menu.addItem(item => {
			item.setTitle('Infinite sessions')
				.setChecked(this.plugin.settings.infiniteSessionsEnabled)
				.onClick(() => {
					this.plugin.settings.infiniteSessionsEnabled = !this.plugin.settings.infiniteSessionsEnabled;
					void this.plugin.saveSettings();
					this.configDirty = true;
					this.updateReasoningBadge();
				});
		});

		menu.showAtMouseEvent(e);
	};

	proto.applyReasoningToSession = function(): void {
		// Agent SDK doesn't support mid-session config changes;
		// mark config as dirty so the next send creates a new session.
		if (!this.configDirty) {
			this.configDirty = true;
		}
	};

	proto.updateReasoningBadge = function(): void {
		const level = this.plugin.settings.reasoningEffort;
		const infiniteSessions = this.plugin.settings.infiniteSessionsEnabled;

		if (this.selectedModel === '') {
			const active = level !== '' || !infiniteSessions;
			this.modelIconEl.toggleClass('is-active', active);
			this.modelIconEl.toggleClass('is-non-interactive', false);
			const parts: string[] = [];
			if (level !== '') parts.push(`effort ${effortLabel(level).toLowerCase()}`);
			if (!infiniteSessions) parts.push('infinite sessions off');
			this.modelIconEl.setAttribute('title', parts.length > 0 ? `Reasoning & context — ${parts.join(', ')}` : 'Reasoning & context (default model)');
			return;
		}

		const model = this.getSelectedModelInfo();
		const supported = model?.capabilities?.supportedReasoningEfforts;
		const supportsReasoning = !!model?.capabilities?.supports?.reasoningEffort && (supported?.length ?? 0) > 0;
		// Reset if current level isn't supported by the new model
		if (level !== '' && supportsReasoning && supported && !supported.includes(level)) {
			this.plugin.settings.reasoningEffort = '';
			void this.plugin.saveSettings();
		}
		const current = this.plugin.settings.reasoningEffort;
		// The icon stays interactive even without reasoning support, because the menu
		// always offers the infinite-sessions toggle.
		const active = (current !== '' && supportsReasoning) || !infiniteSessions;
		this.modelIconEl.toggleClass('is-active', active);
		this.modelIconEl.toggleClass('is-non-interactive', false);
		const parts: string[] = [];
		if (supportsReasoning && current !== '') parts.push(`effort ${effortLabel(current).toLowerCase()}`);
		if (!infiniteSessions) parts.push('infinite sessions off');
		if (!supportsReasoning && infiniteSessions) {
			this.modelIconEl.setAttribute('title', 'Reasoning & context (model does not support reasoning effort)');
		} else {
			this.modelIconEl.setAttribute('title', parts.length > 0 ? `Reasoning & context — ${parts.join(', ')}` : 'Reasoning & context');
		}
	};

	proto.openToolsMenu = function(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		menu.addSeparator();
		const currentApproval = this.plugin.settings.toolApproval;
		menu.addItem(item => {
			item.setTitle('Approval mode');
			const sub: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
			sub.addItem(si => {
				si.setTitle('Allow (auto-approve)')
					.setChecked(currentApproval === 'allow')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'allow';
						await this.plugin.saveSettings();
					});
			});
			sub.addItem(si => {
				si.setTitle('Ask (require approval)')
					.setChecked(currentApproval === 'ask')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'ask';
						await this.plugin.saveSettings();
					});
			});
		});
		menu.showAtMouseEvent(e);
	};

	proto.selectAgent = function(agentName: string): void {
		// Handle deselecting (empty = "Auto" / no agent)
		if (!agentName) {
			this.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.selectedIndex = 0;
			this.agentSelect.title = '';
			this.applyAgentToolsAndSkills(undefined);
			this.configDirty = true;
			return;
		}
		const agent = this.agents.find(a => a.name === agentName)
			// Fallback: case-insensitive match
			?? this.agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
		if (!agent) return; // No matching agent found — leave dropdown unchanged
		this.selectedAgent = agent.name;
		// Update the dropdown — set both .value and .selectedIndex for reliability
		this.agentSelect.value = agent.name;
		const opts = this.agentSelect.options;
		for (let i = 0; i < opts.length; i++) {
			if (opts[i]!.value === agent.name) {
				this.agentSelect.selectedIndex = i;
				break;
			}
		}
		this.agentSelect.title = agent.instructions;
		// Auto-select agent's preferred model
		const resolvedModel = this.resolveModelForAgent(agent, this.selectedModel || undefined);
		if (resolvedModel && resolvedModel !== this.selectedModel) {
			this.selectedModel = resolvedModel;
			this.modelSelect.value = resolvedModel;
		}
		this.applyAgentToolsAndSkills(agent);
		this.configDirty = true;
	};

	proto.applyAgentToolsAndSkills = function(agent?: AgentConfig): void {
		// Skills: undefined = enable all, [] = disable all, [...] = enable listed.
		// This is the agent-declared restriction (AgentConfig.skills), independent
		// from the removed manual toolbar toggle — all discovered skills are always
		// available unless the selected agent explicitly restricts the set.
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.enabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateToolsBadge();
	};

	proto.updateToolsBadge = function(): void {
		// MCP is now SDK-native; badge always shows inactive
		this.toolsBtnEl.toggleClass('is-active', false);
		this.toolsBtnEl.setAttribute('title', 'Tools');
	};

	proto.openCwdPicker = function(): void {
		new FolderTreeModal(this.app, this.workingDir, (folder) => {
			this.workingDir = folder.path;
			this.updateCwdButton();
			this.configDirty = true;
		}).open();
	};

	proto.updateCwdButton = function(): void {
		const vaultName = this.app.vault.getName();
		const label = `Working directory: ${vaultName}/${this.workingDir}`;
		this.cwdBtnEl.setAttribute('title', label);
		this.cwdBtnEl.toggleClass('is-active', true);
	};

	proto.openEditFromChat = function(): void {
		const text = this.inputEl.value.trim();
		new EditModal(this.plugin, text, (result) => {
			this.inputEl.value = result;
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
			this.inputEl.focus();
		}).open();
	};

	proto.resolveModelForAgent = function(agent: AgentConfig | undefined, fallback: string | undefined): string | undefined {
		return resolveModelForAgent(agent, this.models, fallback);
	};
}
