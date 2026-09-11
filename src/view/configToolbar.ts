import {Menu, setIcon} from 'obsidian';
import type {ModelInfo} from '../agentService';
import type {AgentConfig, SkillInfo} from '../types';
import {FolderTreeModal} from '../modals';
import {setDebugEnabled} from '../debug';
import {resolveModelForAgent, mergeLiveAgents, mergeLiveSkills} from './sessionConfig';
import type {ViewContext} from './types';

/** Human label for a reasoning-effort level. 'none' reads as "Off". */
function effortLabel(level: string): string {
	if (level === 'none') return 'Off';
	return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Max characters shown for the working-directory folder name before truncating with an ellipsis (#215). */
const CWD_LABEL_MAX_CHARS = 14;

/**
 * Config-toolbar controller (composition refactor — formerly prototype injection into
 * `SynapseView`, `.docs/research/2026-09-11-view-composition-refactor.md`). Owns the
 * toolbar DOM it builds (reasoning/tools buttons, the send button wiring, the debug
 * toggle, the context gauge) and reaches the shared view state — agents/models/skills,
 * `selectedAgent`/`selectedModel`, `enabledSkills`, `workingDir`, `configDirty`, and the
 * current session's query-metadata caches — through its `ViewContext`.
 *
 * The agent/model `<select>`s and the cwd button stay view-owned elements for now:
 * `SynapseView.updateConfigUI()` rebuilds the selects after every config reload and
 * inputArea.ts creates the cwd button in the state line, so they are reached through
 * the `agentSelect`/`modelSelect`/`cwdBtnEl` accessors below.
 */
export class ConfigToolbarController {
	// ── Toolbar DOM refs (moved from SynapseView) ────────────────
	private reasoningBtnEl!: HTMLButtonElement;
	private toolsBtnEl!: HTMLButtonElement;
	/** Context-window gauge (issue #130) — absent (`is-hidden`) until the first successful capture; see `updateContextIndicator()`. */
	private contextIndicatorEl!: HTMLElement;
	private contextSepEl?: HTMLElement;
	/** Gauge track/fill/value nodes, built once and reused in place so the CSS width transition can animate (#215). */
	private gaugeFillEl?: HTMLElement;
	private gaugeValueEl?: HTMLElement;
	private debugBtnEl!: HTMLElement;

	constructor(private view: ViewContext) {}

	// ── View-owned element/state accessors ───────────────────────
	// Accessors (not copied fields) so the historical `this.<name>` spellings in the
	// methods below keep compiling against state that still lives on `SynapseView`.
	private get agentSelect(): HTMLSelectElement {
		return this.view.view.agentSelect;
	}

	private get modelSelect(): HTMLSelectElement {
		return this.view.view.modelSelect;
	}

	private get cwdBtnEl(): HTMLButtonElement {
		return this.view.view.cwdBtnEl;
	}

	private get selectedAgent(): string {
		return this.view.view.selectedAgent;
	}

	private get selectedModel(): string {
		return this.view.view.selectedModel;
	}

	/** Build the toolbar into `parent` (upper controls row + lower gauge/debug row). */
	build(parent: HTMLElement): void {
		// `synapse-config-toolbar` scopes the editorial (#210) look to this toolbar only — the
		// search tab's toolbar (searchPanel.ts) reuses the bare `.synapse-toolbar`/`.synapse-select`
		// classes for its own pre-existing appearance and must not inherit this restyle (#215).
		const toolbar = parent.createDiv({cls: 'synapse-toolbar synapse-config-toolbar'});

		// Decorative divider between toolbar controls — hidden from screen readers (#215) so
		// they don't announce "slash" between every Agent/Model/Reasoning/Tools/Dir control.
		const addSep = (extraCls?: string): HTMLElement =>
			toolbar.createSpan({
				cls: extraCls ? `synapse-toolbar-sep ${extraCls}` : 'synapse-toolbar-sep',
				text: '/',
				attr: {'aria-hidden': 'true'},
			});

		// Agent dropdown
		this.view.view.agentSelect = toolbar.createEl('select', {cls: 'synapse-select synapse-agent-select'});
		this.agentSelect.toggleClass('is-active', this.selectedAgent !== '');
		this.agentSelect.addEventListener('change', () => {
			this.selectAgent(this.agentSelect.value);
			this.view.view.updateStateLine();
		});

		addSep();

		// Model dropdown
		this.view.view.modelSelect = toolbar.createEl('select', {cls: 'synapse-select synapse-model-select'});
		this.modelSelect.toggleClass('is-active', this.selectedModel !== '');
		this.modelSelect.addEventListener('change', () => this.setModel(this.modelSelect.value));

		addSep();

		// Reasoning effort button — a real <button> (not a <span>) so it's keyboard-focusable
		// and reachable like the Tools/Dir buttons it sits alongside (#215).
		this.reasoningBtnEl = toolbar.createEl('button', {cls: 'synapse-toolbar-btn synapse-reasoning-btn', text: 'Reasoning', attr: {type: 'button'}});
		this.reasoningBtnEl.addEventListener('click', (e) => { e.stopPropagation(); this.openReasoningMenu(e); });
		this.updateReasoningBadge();

		addSep();

		// Tools button — displays selected approval mode ('Ask' | 'Allow')
		this.toolsBtnEl = toolbar.createEl('button', {cls: 'synapse-toolbar-btn synapse-tools-btn', attr: {type: 'button'}});
		this.toolsBtnEl.addEventListener('click', (e) => this.openToolsMenu(e));
		this.updateToolsBadge();

		// Spacer to push send button to the right
		toolbar.createDiv({cls: 'synapse-toolbar-spacer'});

		// Send button (#215) — aligned on the upper toolbar row. `sendBtn` stays a view
		// field: chatRenderer.ts's updateSendButton() swaps its icon/title with stream state.
		this.view.view.sendBtn = toolbar.createEl('button', {
			cls: 'clickable-icon synapse-send-btn',
			attr: {title: 'Send message', type: 'button'},
		});
		setIcon(this.view.view.sendBtn, 'arrow-up');
		this.view.view.sendBtn.addEventListener('click', () => {
			if (this.view.isStreaming) {
				void this.view.view.handleAbort();
			} else {
				void this.view.view.handleSend();
			}
		});

		// Lower toolbar: Context gauge and Debug toggle
		const lowerToolbar = parent.createDiv({cls: 'synapse-toolbar synapse-config-toolbar-lower'});

		// Context-window gauge (issue #130, #210) — hairline meter on the left
		this.contextIndicatorEl = lowerToolbar.createDiv({cls: 'synapse-context-indicator synapse-context-gauge is-hidden'});

		// Spacer to push debug toggle to the right
		lowerToolbar.createDiv({cls: 'synapse-toolbar-spacer'});

		// Debug toggle on the right
		this.debugBtnEl = lowerToolbar.createDiv({cls: 'synapse-debug-toggle', attr: {title: 'Show tool & token details'}});
		this.debugBtnEl.createSpan({cls: 'synapse-debug-label', text: 'Debug'});
		const debugCheck = this.debugBtnEl.createEl('input', {type: 'checkbox', cls: 'synapse-debug-checkbox'});
		debugCheck.checked = this.view.view.showDebugInfo;
		this.debugBtnEl.toggleClass('is-active', this.view.view.showDebugInfo);
		debugCheck.addEventListener('change', () => {
			this.view.view.showDebugInfo = debugCheck.checked;
			this.debugBtnEl.toggleClass('is-active', this.view.view.showDebugInfo);
			setDebugEnabled(this.view.view.showDebugInfo);
			this.view.chatContainer.toggleClass('synapse-hide-debug', !this.view.view.showDebugInfo);
		});
		this.debugBtnEl.addEventListener('click', (e) => {
			if (e.target !== debugCheck) {
				debugCheck.checked = !debugCheck.checked;
				debugCheck.dispatchEvent(new Event('change'));
			}
		});
	}

	populateModelSelect(): void {
		this.modelSelect.empty();
		const defaultOpt = this.modelSelect.createEl('option', {text: 'Default model'});
		defaultOpt.value = '';
		for (const model of this.view.view.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		this.modelSelect.value = this.selectedModel;
		this.modelSelect.toggleClass('is-active', this.selectedModel !== '');
		this.view.view.updateStateLine();
	}

	private getSelectedModelInfo(): ModelInfo | undefined {
		return this.view.view.models.find(m => m.id === this.selectedModel);
	}

	/**
	 * Single source of truth for a model change — the toolbar's `modelSelect` is the sole
	 * model-switching UI (the composer's duplicate model-picker button was removed, #215 AC-2).
	 *
	 * Resets any reasoning effort the new model doesn't support first, then carries the
	 * (now-valid) effort + summary into the mid-session switch.
	 */
	setModel(modelId: string): void {
		this.view.view.selectedModel = modelId;
		if (this.modelSelect) {
			this.modelSelect.value = modelId;
			this.modelSelect.toggleClass('is-active', modelId !== '');
		}
		this.updateReasoningBadge();
		this.applyReasoningToSession();
		this.view.view.updateStateLine();
	}

	private openReasoningMenu(e: MouseEvent): void {
		const model = this.getSelectedModelInfo();
		// The SDK narrows supportedReasoningEfforts to its ReasoningEffort union, but
		// models report values beyond it (e.g. 'max', 'none'); treat them as strings.
		const supported = model?.capabilities?.supportedReasoningEfforts;
		const supportsReasoning = !!model?.capabilities?.supports?.reasoningEffort && !!supported && supported.length > 0;
		const menu = new Menu();

		if (this.selectedModel === '') {
			menu.addItem(item => item.setTitle('Default model (capabilities unknown)').setDisabled(true));
		} else if (supportsReasoning) {
			const current = this.view.plugin.settings.reasoningEffort;
			for (const level of supported) {
				menu.addItem(item => {
					item.setTitle(effortLabel(level))
						.setChecked(level === current)
						.onClick(() => {
							// Toggle back to model default if the active level is re-selected.
							this.view.plugin.settings.reasoningEffort = level === current ? '' : level;
							void this.view.plugin.saveSettings();
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
				.setChecked(this.view.plugin.settings.infiniteSessionsEnabled)
				.onClick(() => {
					this.view.plugin.settings.infiniteSessionsEnabled = !this.view.plugin.settings.infiniteSessionsEnabled;
					void this.view.plugin.saveSettings();
					this.view.configDirty = true;
					this.updateReasoningBadge();
				});
		});

		menu.showAtMouseEvent(e);
	}

	applyReasoningToSession(): void {
		// This plugin creates a fresh query() per turn (resuming via `resume`) rather than
		// holding a live Query between turns, so there's no live handle to mutate mid-turn —
		// config changes like this one apply on the next turn simply by living in
		// `this.config`. Mark config dirty so `ensureSession()` rebuilds the Session (its
		// `resume` carries the conversation across the rebuild — see `ensureSession()`).
		if (!this.view.configDirty) {
			this.view.configDirty = true;
		}
	}

	updateReasoningBadge(): void {
		const level = this.view.plugin.settings.reasoningEffort;
		const infiniteSessions = this.view.plugin.settings.infiniteSessionsEnabled;
		// Text stays sentence case; `.synapse-toolbar-btn`'s CSS `text-transform: uppercase`
		// handles the visual presentation (#215) — see the same reasoning on `updateCwdButton()`.
		const setLabel = (effort?: string): void => {
			this.reasoningBtnEl.setText(effort || 'Reasoning');
		};

		if (this.selectedModel === '') {
			const active = level !== '';
			this.reasoningBtnEl.toggleClass('is-active', active);
			this.reasoningBtnEl.toggleClass('is-non-interactive', false);
			setLabel(level !== '' ? effortLabel(level) : undefined);
			const parts: string[] = [];
			if (level !== '') parts.push(`effort ${effortLabel(level).toLowerCase()}`);
			if (!infiniteSessions) parts.push('infinite sessions off');
			this.reasoningBtnEl.setAttribute('title', parts.length > 0 ? `Reasoning & context — ${parts.join(', ')}` : 'Reasoning & context (default model)');
			return;
		}

		const model = this.getSelectedModelInfo();
		const supported = model?.capabilities?.supportedReasoningEfforts;
		const supportsReasoning = !!model?.capabilities?.supports?.reasoningEffort && (supported?.length ?? 0) > 0;
		// Reset if current level isn't supported by the new model
		if (level !== '' && supportsReasoning && supported && !supported.includes(level)) {
			this.view.plugin.settings.reasoningEffort = '';
			void this.view.plugin.saveSettings();
		}
		const current = this.view.plugin.settings.reasoningEffort;
		// The button stays interactive even without reasoning support, because the menu
		// always offers the infinite-sessions toggle.
		const active = current !== '' && supportsReasoning;
		this.reasoningBtnEl.toggleClass('is-active', active);
		this.reasoningBtnEl.toggleClass('is-non-interactive', false);
		setLabel(supportsReasoning && current !== '' ? effortLabel(current) : undefined);
		const parts: string[] = [];
		if (supportsReasoning && current !== '') parts.push(`effort ${effortLabel(current).toLowerCase()}`);
		if (!infiniteSessions) parts.push('infinite sessions off');
		if (!supportsReasoning && infiniteSessions) {
			this.reasoningBtnEl.setAttribute('title', 'Reasoning & context (model does not support reasoning effort)');
		} else {
			this.reasoningBtnEl.setAttribute('title', parts.length > 0 ? `Reasoning & context — ${parts.join(', ')}` : 'Reasoning & context');
		}
	}

	private openToolsMenu(e: MouseEvent): void {
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
						this.updateToolsBadge();
					});
			});
			sub.addItem(si => {
				si.setTitle('Ask (require approval)')
					.setChecked(currentApproval === 'ask')
					.onClick(async () => {
						this.view.plugin.settings.toolApproval = 'ask';
						await this.view.plugin.saveSettings();
						this.updateToolsBadge();
					});
			});
		});
		menu.showAtMouseEvent(e);
	}

	selectAgent(agentName: string): void {
		// Handle deselecting (empty = "Auto" / no agent)
		if (!agentName) {
			this.view.view.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.selectedIndex = 0;
			this.agentSelect.title = '';
			this.agentSelect.toggleClass('is-active', false);
			this.applyAgentToolsAndSkills(undefined);
			this.view.configDirty = true;
			// Deselecting was previously the one branch that didn't refresh the state line
			// (#217) — it displays the active agent, so it needs to reflect "Auto" too.
			this.view.view.updateStateLine();
			return;
		}
		const effectiveAgents = this.getEffectiveAgents();
		const agent = effectiveAgents.find(a => a.name === agentName)
			// Fallback: case-insensitive match
			?? effectiveAgents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
		if (!agent) return; // No matching agent found — leave dropdown unchanged
		this.view.view.selectedAgent = agent.name;
		// Update the dropdown — set both .value and .selectedIndex for reliability
		this.agentSelect.value = agent.name;
		this.agentSelect.toggleClass('is-active', true);
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
			this.view.view.selectedModel = resolvedModel;
			this.modelSelect.value = resolvedModel;
			this.modelSelect.toggleClass('is-active', resolvedModel !== '');
		}
		this.applyAgentToolsAndSkills(agent);
		this.view.configDirty = true;
		this.view.view.updateStateLine();
	}

	applyAgentToolsAndSkills(agent?: AgentConfig): void {
		// Skills: undefined = enable all, [] = disable all, [...] = enable listed.
		// This is the agent-declared restriction (AgentConfig.skills), independent
		// from the removed manual toolbar toggle — all discovered skills are always
		// available unless the selected agent explicitly restricts the set.
		const effectiveSkills = this.getEffectiveSkills();
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.view.view.enabledSkills = new Set(
				effectiveSkills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.view.view.enabledSkills = new Set(effectiveSkills.map(s => s.name));
		}

		this.updateToolsBadge();
	}

	updateToolsBadge(): void {
		const approval = this.view.plugin.settings.toolApproval;
		const label = approval === 'allow' ? 'Allow' : 'Ask';
		this.toolsBtnEl.toggleClass('is-active', approval === 'allow');
		this.toolsBtnEl.setAttribute('title', `Tools approval: ${approval === 'allow' ? 'Allow (auto-approve)' : 'Ask (require approval)'}`);
		if (this.toolsBtnEl.textContent !== label) {
			this.toolsBtnEl.setText(label);
		}
	}

	openCwdPicker(): void {
		new FolderTreeModal(this.view.app, this.view.view.workingDir, (folder) => {
			this.view.view.workingDir = folder.path;
			this.updateCwdButton();
			this.view.configDirty = true;
		}).open();
	}

	updateCwdButton(): void {
		if (!this.cwdBtnEl) return;
		const vaultName = this.view.app.vault.getName();
		const label = this.view.view.workingDir
			? `Working directory: ${vaultName}/${this.view.view.workingDir}`
			: `Working directory: ${vaultName} (vault root)`;
		this.cwdBtnEl.setAttribute('title', label);
		const hasFolder = Boolean(this.view.view.workingDir && this.view.view.workingDir !== '' && this.view.view.workingDir !== '/');
		this.cwdBtnEl.toggleClass('is-active', hasFolder);
		const folderName = this.view.view.workingDir ? (this.view.view.workingDir.split('/').pop() || this.view.view.workingDir) : '';
		// Truncate only the folder-name portion so a long name doesn't squeeze the state line row
		// (#215); the full name is always available via the `title` set above. Written in
		// sentence case — `.synapse-toolbar-btn`'s CSS `text-transform: uppercase` handles the
		// visual presentation, avoiding a bare `toUpperCase()` call (locale-sensitive, and it
		// would make screen readers spell out "DIR colon RESEARCH" instead of natural case).
		const truncated = folderName.length > CWD_LABEL_MAX_CHARS
			? `${folderName.slice(0, CWD_LABEL_MAX_CHARS - 1)}…`
			: folderName;
		this.cwdBtnEl.setText(truncated ? truncated : 'Dir');
	}

	/**
	 * The agent list to render/select from (issue #130): the live session's
	 * `supportedAgents()` capture when one exists, else the `_synapse/agents/` directory
	 * scan (`this.agents`). A session that has never sent a turn has no capture yet, so this
	 * transparently returns the scan result — the pre-#130 fallback behavior is unchanged.
	 */
	getEffectiveAgents(): AgentConfig[] {
		// Current session's capture first, then the view's last-known one (#163) — a config
		// change rebuilds the Session and empties its cache, and dropping to the directory scan
		// there made CLI-provided agents vanish mid-conversation.
		const live = this.view.view.currentSession?.cachedSupportedAgents ?? this.view.view.lastSupportedAgents;
		if (!live) return this.view.view.agents;
		// The CLI decides membership; the vault scan supplies the richer config for any
		// agent present in both. Replacing a scanned `AgentConfig` wholesale would drop its
		// declared `tools`/`skills`, and `applyAgentToolsAndSkills()` reads `skills:
		// undefined` as "enable all" — silently widening a deliberately narrowed agent.
		return mergeLiveAgents(live, this.view.view.agents);
	}

	/**
	 * The skill/slash-command list to render/select from (issue #130): the live session's
	 * `supportedCommands()` capture when one exists, else the `_synapse/skills/` directory
	 * scan (`this.skills`). Same fallback guarantee as `getEffectiveAgents()`.
	 */
	getEffectiveSkills(): SkillInfo[] {
		// Same fallback chain as `getEffectiveAgents()` — see `lastSupportedCommands` (#163).
		const live = this.view.view.currentSession?.cachedSupportedCommands ?? this.view.view.lastSupportedCommands;
		if (!live) return this.view.view.skills;
		// Merged by name for the same reason as `getEffectiveAgents()`, so a vault skill
		// keeps its `folderPath` instead of being flattened to `''`. Nothing reads
		// `SkillInfo.folderPath` today, so this is defensive rather than load-bearing.
		return mergeLiveSkills(live, this.view.view.skills);
	}

	/**
	 * Reflect the session's cached `getContextUsage()` snapshot (issue #130, #210) in the toolbar
	 * gauge. Renders as a hairline meter: a 2px track that fills with the accent, with its
	 * numeric readout in tabular mono.
	 *
	 * Renders nothing — not a zero, not a placeholder — until the first successful capture,
	 * and applies only to the real Agent SDK path: a BYOK local model's `Session` never
	 * populates `cachedContextUsage`, so the indicator stays absent for the entire
	 * conversation rather than showing a number that was never actually measured.
	 */
	updateContextIndicator(): void {
		const usage = this.view.view.currentSession?.cachedContextUsage;
		if (!usage) {
			this.contextIndicatorEl.addClass('is-hidden');
			if (this.contextSepEl) this.contextSepEl.addClass('is-hidden');
			return;
		}
		// Round once and use the rounded value for BOTH the displayed text and the
		// warning/critical thresholds, so the number and its severity color never disagree
		// (#215) — e.g. a raw 74.6% used to show "75%" while staying un-highlighted.
		const pct = Math.min(100, Math.max(0, Math.round(usage.percentage)));
		this.contextIndicatorEl.removeClass('is-hidden');
		if (this.contextSepEl) this.contextSepEl.removeClass('is-hidden');

		// Build the track/fill/value nodes once and update them in place on subsequent calls
		// (#215) — recreating them every update discarded the element the CSS `transition:
		// width 0.2s ease` rule on `.synapse-gauge-fill` was meant to animate.
		if (!this.gaugeFillEl || !this.gaugeValueEl) {
			this.contextIndicatorEl.empty();
			const track = this.contextIndicatorEl.createDiv({cls: 'synapse-gauge-track'});
			this.gaugeFillEl = track.createDiv({cls: 'synapse-gauge-fill'});
			this.gaugeValueEl = this.contextIndicatorEl.createSpan({cls: 'synapse-gauge-value'});
		}

		// A CSS custom property (not inline `style.width`) so this stays consistent with the
		// same shared `.synapse-gauge-fill`/`.synapse-gauge-track` classes elsewhere (#215).
		this.gaugeFillEl.setCssProps({'--progress-width': `${pct}%`});
		this.gaugeValueEl.setText(`${pct}%`);

		this.contextIndicatorEl.setAttribute(
			'title',
			`Context window: ~${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens (${pct}%). ` +
				'One turn stale — refreshed at the end of each turn.'
		);
		this.contextIndicatorEl.toggleClass('is-context-warning', pct >= 75 && pct < 90);
		this.contextIndicatorEl.toggleClass('is-context-critical', pct >= 90);
	}

	resolveModelForAgent(agent: AgentConfig | undefined, fallback: string | undefined): string | undefined {
		return resolveModelForAgent(agent, this.view.view.models, fallback);
	}
}
