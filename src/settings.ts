import {App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem, TFile, normalizePath} from "obsidian";
import SynapsePlugin from "./main";
import {scanAgents, installStarterKit} from "./configWriter";
import {testLocalAgentEndpoint} from "./providerModels";
import {BUNDLED_SDK_VERSION, getVersionSkewWarning} from "./runtimeManager";
// Re-exported so existing `import {SYNAPSE_FOLDER} from './settings'` call sites (notably
// configWriter.ts, out of scope for #153) keep working. Canonical definition: vaultPaths.ts.
import {SYNAPSE_FOLDER} from "./vaultPaths";
export {SYNAPSE_FOLDER};

/** Helper to update a secure field in both runtime settings and local storage. */
function updateSecureField(app: App, plugin: SynapsePlugin, key: keyof SynapseSettings, value: string): void {
	(plugin.settings as unknown as Record<string, unknown>)[key] = value;
	saveSecureField(app, key, value);
}

export interface FeatureAgentMap {
	chat: string;
	inline: string;
	search: string;
	telegram: string;
	vision: string;
}

export interface SynapseSettings {
	/** Auth type: 'subscription' uses Claude CLI OAuth, 'apiKey' uses an Anthropic API key. */
	authType: 'subscription' | 'apiKey';
	/** Anthropic API key (stored securely via local storage). */
	anthropicApiKey: string;
	/** Custom path to the claude CLI binary. Empty = auto-detect. */
	claudeLocation: string;
	/**
	 * Local agent endpoint base URL (issue #122) — a Messages-API-speaking backend (Ollama
	 * v0.14.0+ natively, or another compatible endpoint). When set, local-model chat/inline/search
	 * queries route through the real Agent SDK/CLI (`ANTHROPIC_BASE_URL` repointed at this URL)
	 * — the only way local models run since the OpenAI-compatible provider matrix and its
	 * hand-rolled ReAct loop were removed (#220) — gaining skills, subagents, sessions,
	 * permission modes, and streaming. Independent of `authType` (used for Claude models only).
	 */
	localAgentEndpointUrl: string;
	/**
	 * API key sent as `ANTHROPIC_API_KEY` to the local agent endpoint (stored securely via local
	 * storage). Ollama requires the header to be present but ignores its value — leave blank to
	 * send the literal `'ollama'` automatically.
	 */
	localAgentEndpointApiKey: string;
	toolApproval: 'ask' | 'allow';
	/** Feature to Agent mapping for plugin features. */
	featureAgents: FeatureAgentMap;

	/** Persisted form defaults for the Edit modal. */
	editModalDefaults?: EditModalDefaults;
	/** Custom display names for sessions, keyed by SDK sessionId. */
	sessionNames?: Record<string, string>;
	/**
	 * Reasoning effort level for model inference. '' = model default.
	 * Stored as a free string because models report values beyond the SDK's
	 * `ReasoningEffort` union (e.g. 'max', 'none'); validity is enforced against
	 * `model.supportedReasoningEfforts` at render time.
	 */
	reasoningEffort: string;
	/** Agent name used for semantic search. */
	searchAgent: string;
	/** Search mode: 'basic' reuses session with minimal config, 'advanced' allows full agent/model/skills/tools. */
	searchMode: 'basic' | 'advanced';

	/** Automatically update working directory to the active note's parent folder. */
	autoUpdateWorkingDirectory: boolean;

	/** Automatically resolve and attach note-embedded images as context. */
	autoIncludeNoteImages: boolean;
	/** Maximum number of note-embedded images to auto-attach per message. */
	maxNoteImages: number;

	/** Telegram Bot ID (informational, not secret). */
	telegramBotId: string;
	/** Telegram Bot token (stored securely via local storage). */
	telegramBotToken: string;
	/** Comma-separated list of allowed Telegram user IDs. Empty = allow all. */
	telegramAllowedUsers: string;
	/** Default agent for Telegram bot sessions. */
	telegramDefaultAgent: string;
	/** Custom request timeout in seconds (0 = use adaptive default). */
	providerRequestTimeout?: number;

	/**
	 * Interactive Tier-1 loop guardrails (issue #88): opt-in per-run turn/cost
	 * thresholds, distinct from the SDK's raw `maxTurns`, that auto-cancel the
	 * in-flight chat session via `Session.abort()` and surface why. `0` means
	 * "no threshold" for both.
	 */
	/** Max turns (assistant.turn_start events) per chat run before auto-cancelling. 0 = off. */
	loopTurnThreshold: number;
	/** Max cumulative tokens (input+output+cache) per chat run before auto-cancelling. 0 = off. */
	loopTokenThreshold: number;
	/**
	 * Max cumulative dollar cost per chat run. 0 = off. Unlike the turn/token
	 * thresholds, this cannot drive true in-flight cancellation — the SDK only
	 * reports `total_cost_usd` on the terminal `result` message, after the run
	 * has already finished (see specs/agent-service.md). When set, an exceeded
	 * run surfaces an informational "over budget" chat message after the fact
	 * rather than a false "cancelled" claim.
	 */
	loopCostThresholdUsd: number;
}

/** Persisted preferences for the Edit modal form. */
export interface EditModalDefaults {
	task: string;
	adjustTask: boolean;
	tone: string;
	adjustTone: boolean;
	format: string;
	adjustFormat: boolean;
	length: number;
	adjustLength: boolean;
	choices: number;
	editPrompt: string;
}

export const DEFAULT_EDIT_MODAL: EditModalDefaults = {
	task: 'Rewrite',
	adjustTask: false,
	tone: 'Professional',
	adjustTone: false,
	format: 'Single paragraph',
	adjustFormat: false,
	length: 5,
	adjustLength: false,
	choices: 4,
	editPrompt: '',
};

export const DEFAULT_SETTINGS: SynapseSettings = {
	authType: 'subscription',
	anthropicApiKey: '',
	claudeLocation: '',
	localAgentEndpointUrl: '',
	localAgentEndpointApiKey: '',
	toolApproval: 'ask',
	featureAgents: {
		chat: '',
		inline: '',
		search: '',
		telegram: '',
		vision: '',
	},

	reasoningEffort: '',
	searchAgent: '',
	searchMode: 'basic',
	autoUpdateWorkingDirectory: true,
	autoIncludeNoteImages: true,
	maxNoteImages: 3,
	telegramBotId: '',
	telegramBotToken: '',
	telegramAllowedUsers: '',
	telegramDefaultAgent: '',
	providerRequestTimeout: 0,
	loopTurnThreshold: 0,
	loopTokenThreshold: 0,
	loopCostThresholdUsd: 0,
}

/** Fields stored in vault-specific local storage instead of data.json. */
export const SECURE_FIELDS: ReadonlyArray<keyof SynapseSettings> = ['anthropicApiKey', 'telegramBotToken', 'localAgentEndpointApiKey'];

const SECURE_PREFIX = 'synapse-secure-';

/** Load a secure field from vault-specific local storage. */
export function loadSecureField(app: App, key: string): string {
	// loadLocalStorage() is typed `any | null` in obsidian.d.ts; narrow to unknown.
	// saveSecureField() below only ever stores a string or null, so this is safe.
	const stored: unknown = app.loadLocalStorage(SECURE_PREFIX + key);
	return typeof stored === 'string' ? stored : '';
}

/** Save a secure field to vault-specific local storage. */
export function saveSecureField(app: App, key: string, value: string): void {
	app.saveLocalStorage(SECURE_PREFIX + key, value || null);
}

/** Helper to update frontmatter model property in markdown file content. */
export function updateAgentModelInContent(content: string, newModel: string): string {
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!fmMatch) {
		return `---\nmodel: ${newModel}\n---\n${content}`;
	}
	let fm = fmMatch[1]!;
	const body = fmMatch[2]!;
	if (/^model\s*:/m.test(fm)) {
		if (newModel.trim()) {
			fm = fm.replace(/^model\s*:.*$/m, `model: ${newModel.trim()}`);
		} else {
			fm = fm.replace(/^model\s*:.*$\r?\n?/m, '');
		}
	} else {
		if (newModel.trim()) {
			fm = fm.trim() + `\nmodel: ${newModel.trim()}`;
		}
	}
	return `---\n${fm.trim()}\n---\n${body}`;
}

/** Helper to update an agent file's bound model in vault. */
export async function updateAgentModelFile(app: App, filePath: string, newModel: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
	if (file instanceof TFile) {
		const content = await app.vault.read(file);
		const updated = updateAgentModelInContent(content, newModel);
		await app.vault.modify(file, updated);
	}
}




export class SynapseSettingTab extends PluginSettingTab {
	plugin: SynapsePlugin;

	constructor(app: App, plugin: SynapsePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const sections = [
			{
				id: 'claude', name: 'Claude',
				desc: 'Authentication, Anthropic API key, Claude CLI location, and local agent endpoint.',
				aliases: ['authentication', 'Anthropic API key', 'Claude CLI', 'local agent endpoint'],
			},
			{
				id: 'agents', name: 'Feature Map & Agents',
				desc: 'Feature-to-agent assignments and per-agent model bindings.',
				aliases: ['feature map', 'agent', 'model binding'],
			},
			{
				id: 'capabilities', name: 'Capabilities',
				desc: 'Synapse folder initialization, editor options, and chat run guardrails.',
				aliases: ['initialize', 'editor integration', 'turn limit', 'token budget', 'dollar budget'],
			},
			{
				id: 'tools', name: 'Tools',
				desc: 'Tool approval mode for agent actions.',
				aliases: ['tool approval', 'ask', 'allow'],
			},
			{
				id: 'bots', name: 'Bots',
				desc: 'Telegram bot token, allowed user IDs, and default agent.',
				aliases: ['Telegram', 'bot token', 'allowed user IDs'],
			},
		] as const;

		return sections.map(({id, name, desc, aliases}): SettingDefinitionItem => ({
			type: 'page' as const,
			name,
			desc,
			// Settings search indexes definitions inside a page, rather than the page
			// link itself. The one imperative child gives each section's aliases a
			// searchable entry and routes its result to this page.
			items: [{
				name,
				desc,
				aliases: [...aliases],
				render: (setting) => this.renderSettings(setting.settingEl, id),
			}],
		}));
	}

	/** Render the stateful settings interface in the selected declarative settings page. */
	private renderSettings(containerEl: HTMLElement, selectedTab: 'claude' | 'agents' | 'capabilities' | 'tools' | 'bots'): void {

		containerEl.empty();
		containerEl.addClass('synapse-settings');

		// ── Tab bar ──────────────────────────────────────────────
		const tabBar = containerEl.createDiv({cls: 'synapse-settings-tab-bar'});
		const panels: Record<string, HTMLElement> = {};
		const tabButtons: Record<string, HTMLElement> = {};
		const tabIds = ['claude', 'agents', 'capabilities', 'tools', 'bots'] as const;
		const tabLabels: Record<string, string> = {
			claude: 'Claude',
			agents: 'Feature Map & Agents',
			capabilities: 'Capabilities',
			tools: 'Tools',
			bots: 'Bots',
		};

		const switchSettingsTab = (id: string) => {
			for (const tid of tabIds) {
				panels[tid]?.toggleClass('is-hidden', tid !== id);
				tabButtons[tid]?.toggleClass('is-active', tid === id);
			}
		};

		for (const id of tabIds) {
			const btn = tabBar.createEl('button', {
				cls: 'synapse-settings-tab',
				text: tabLabels[id],
			});
			btn.addEventListener('click', () => switchSettingsTab(id));
			tabButtons[id] = btn;
		}

		// ── Panels ───────────────────────────────────────────────
		const agentsFolder = normalizePath(`${SYNAPSE_FOLDER}/agents`);
		if (!this.app.vault.getAbstractFileByPath(agentsFolder)) {
			const warning = containerEl.createDiv({cls: 'synapse-settings-warning'});
			warning.createEl('p', {
				text: 'Synapse folder is not initialized. Use the capabilities tab to set it up.',
			});
		}

		for (const id of tabIds) {
			panels[id] = containerEl.createDiv({cls: `synapse-settings-panel${id === 'claude' ? '' : ' is-hidden'}`});
		}
		switchSettingsTab(selectedTab);

		// ══════════════════════════════════════════════════════════
		// TAB 1: Claude (auth)
		// ══════════════════════════════════════════════════════════
		this.renderClaudePanel(panels['claude']!);

		// ══════════════════════════════════════════════════════════
		// TAB 2: Feature Map & Agents
		// ══════════════════════════════════════════════════════════
		this.renderAgentsPanel(panels['agents']!);

		// ══════════════════════════════════════════════════════════
		// TAB 3: Capabilities
		// ══════════════════════════════════════════════════════════
		this.renderCapabilitiesPanel(panels['capabilities']!);

		// ══════════════════════════════════════════════════════════
		// TAB 4: Tools
		// ══════════════════════════════════════════════════════════
		this.renderToolsPanel(panels['tools']!);

		// ══════════════════════════════════════════════════════════
		// TAB 5: Bots
		// ══════════════════════════════════════════════════════════
		const botsPanel = panels['bots']!;
		this.renderBotsPanel(botsPanel);
	}

	/** Render the Claude tab (auth, CLI location, local & custom BYOK provider). */
	private renderClaudePanel(panel: HTMLElement): void {
		const authFieldsEl = panel.createDiv();

		const renderAuthFields = () => {
			authFieldsEl.empty();
			if (this.plugin.settings.authType === 'apiKey') {
				new Setting(authFieldsEl)
					.setName('Anthropic API key')
					.setDesc('Anthropic API key (stored securely)')
					.addText(text => {
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.setPlaceholder('sk-ant-...')
							.setValue(this.plugin.settings.anthropicApiKey)
							.onChange(async (value) => {
								updateSecureField(this.app, this.plugin, 'anthropicApiKey', value.trim());
								await this.plugin.initAgentService();
							});
					});
			} else {
				authFieldsEl.createEl('p', {
					text: 'Using Claude subscription via the Claude CLI. Make sure you are logged in (run "claude login" in a terminal).',
					cls: 'setting-item-description',
				});
			}
		};

		new Setting(panel)
			.setName('Authentication')
			.setDesc('How to authenticate with Claude.')
			.addDropdown(dropdown => dropdown
				.addOptions({subscription: 'Claude subscription (OAuth)', apiKey: 'Anthropic API key'})
				.setValue(this.plugin.settings.authType)
				.onChange(async (value) => {
					this.plugin.settings.authType = value as 'subscription' | 'apiKey';
					await this.plugin.saveSettings();
					await this.plugin.initAgentService();
					renderAuthFields();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						if (!this.plugin.agentService) {
							throw new Error('Claude service is not available');
						}
						const models = await this.plugin.agentService.fetchModels();
						this.plugin.notifySidebarModelsChanged(models);
						new Notice(`Connected — found ${models.length} model(s).`);
					} catch (e) {
						new Notice(`Test failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		panel.appendChild(authFieldsEl);
		renderAuthFields();

		new Setting(panel)
			.setName('Claude CLI location')
			.setDesc('Custom path to the Claude CLI binary. Leave blank to auto-detect.')
			.addText(text => text
				.setPlaceholder('Auto-detect')
				.setValue(this.plugin.settings.claudeLocation)
				.onChange(async (value) => {
					this.plugin.settings.claudeLocation = value.trim();
					await this.plugin.saveSettings();
					await this.plugin.initAgentService();
					await renderCliStatus();
				}));

		const cliStatusEl = panel.createDiv({cls: 'setting-item-description synapse-settings-cli-status'});
		const cliSkewEl = panel.createDiv({cls: 'setting-item-description mod-warning synapse-settings-cli-skew'});
		const renderCliStatus = async () => {
			cliStatusEl.empty();
			cliSkewEl.empty();
			if (this.plugin.agentService) {
				try {
					const resolved = await this.plugin.agentService.getVersionInfo();
					const sourceLabels: Record<string, string> = {
						'settings': 'settings override',
						'global-npm': 'global npm install',
						'os-links': 'OS links',
						'sdk-fallback': 'SDK package fallback',
					};
					const sourceStr = sourceLabels[resolved.source] ?? resolved.source;
					let infoStr = `Resolved CLI: ${resolved.path} (from ${sourceStr})`;
					if (resolved.version) {
						infoStr += ` \u2014 v${resolved.version} (SDK v${BUNDLED_SDK_VERSION})`;
					}
					cliStatusEl.setText(infoStr);
					if (resolved.version) {
						const warning = getVersionSkewWarning(resolved.version);
						if (warning) cliSkewEl.setText(`\u26a0 ${warning}`);
					}
				} catch {
					cliStatusEl.setText('Resolved CLI: not found');
				}
			}
		};
		void renderCliStatus();

		// ── Local agent endpoint (issue #122) ─────────────
		const localAgentEndpointPlaceholder = 'http://localhost:11434';
		new Setting(panel)
			.setName('Local agent endpoint')
			.setHeading();
		panel.createEl('p', {
			text: 'Point this at Ollama (default localhost:11434, v0.14.0+) or another endpoint that speaks the Anthropic Messages API. When set, chat, inline, and search queries against a local model run through the same Claude Agent SDK as Claude sessions — full streaming, tool use, skills, and permission modes. The endpoint\'s model catalogue is fetched automatically and the models appear in the chat panel\'s model picker. A user-supplied URL redirects the entire agent loop, including tool calls, to that endpoint: only point this at an endpoint you trust with your conversation and tool-call data.',
			cls: 'setting-item-description',
		});

		new Setting(panel)
			.setName('Endpoint URL')
			.setDesc('Base URL of an endpoint that speaks the Anthropic Messages API. Blank = only Claude models are available.')
			.addText(text => text
				.setPlaceholder(localAgentEndpointPlaceholder)
				.setValue(this.plugin.settings.localAgentEndpointUrl)
				.onChange(async (val) => {
					this.plugin.settings.localAgentEndpointUrl = val.trim();
					await this.plugin.saveSettings();
					await this.plugin.initAgentService();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					// Blank-URL guard runs before the disable/'Testing…' dance (AC-3): no
					// network request and no visual churn when there is nothing to probe.
					if (!this.plugin.settings.localAgentEndpointUrl.trim()) {
						new Notice('Endpoint URL is empty — enter one above (default for Ollama: localhost:11434).');
						return;
					}
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						const res = await testLocalAgentEndpoint({
							baseUrl: this.plugin.settings.localAgentEndpointUrl,
							apiKey: this.plugin.settings.localAgentEndpointApiKey,
						});
						if (res.ok) {
							if (res.messageId !== undefined) {
								new Notice('Endpoint reachable — Messages API responded.');
							} else {
								// The Messages API answered with an Anthropic-shaped error
								// (e.g. probe model not installed on that endpoint) — the
								// endpoint itself is proven reachable and API-shaped.
								new Notice(`Endpoint reachable — Messages API answered${res.note ? `: ${res.note}` : '.'}`);
							}
						} else {
							// Connection-vs-shape distinction is baked into `error` itself
							// (`isConnectionError`'s message names the unreachable-endpoint
							// fix; the wrong-shape messages name the response shape).
							new Notice(`Test failed: ${res.error}`);
						}
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		new Setting(panel)
			.setName('Endpoint API key')
			.setDesc("API key header sent to the endpoint. Ollama requires the header but ignores its value — leave blank to send 'Ollama' automatically. Stored securely.")
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.setValue(this.plugin.settings.localAgentEndpointApiKey)
					.onChange(async (val) => {
						updateSecureField(this.app, this.plugin, 'localAgentEndpointApiKey', val.trim());
						await this.plugin.initAgentService();
					});
			});
	}

	/** Render the Feature Map & Agents tab. */
	private renderAgentsPanel(panel: HTMLElement): void {

		new Setting(panel)
			.setName('Feature -> Agent map')
			.setHeading();
		panel.createEl('p', {
			text: 'Map each plugin feature to a specific agent persona. Lightweight features default to a Claude model out of the box.',
			cls: 'setting-item-description',
		});

		const renderAgentsPanel = async () => {
			const dynamicContainerId = 'synapse-agents-dynamic';
			let dynamicContainer = panel.querySelector(`#${dynamicContainerId}`) as HTMLElement;
			if (dynamicContainer) {
				dynamicContainer.empty();
			} else {
				dynamicContainer = panel.createDiv({attr: {id: dynamicContainerId}});
			}

			const vaultAgents = await scanAgents(this.app, normalizePath(`${SYNAPSE_FOLDER}/agents`));
			const agentNamesSet = new Set<string>(vaultAgents.map(a => a.name));
			const agentOptions: Record<string, string> = {
				'': 'Auto'
			};
			for (const name of agentNamesSet) {
				agentOptions[name] = name;
			}

			const features: Array<{id: keyof FeatureAgentMap; name: string; desc: string}> = [
				{id: 'chat', name: 'Chat panel', desc: 'Default agent for main conversation sidebar.'},
				{id: 'inline', name: 'Inline editor operations', desc: 'Default agent for context-menu actions (rewrite, summarize, structure).'},
				{id: 'search', name: 'Semantic search', desc: 'Default agent for vault semantic search.'},
				{id: 'telegram', name: 'Telegram bot', desc: 'Default agent for responding to incoming Telegram messages.'},
				{id: 'vision', name: 'Vision & image reading', desc: 'Handler agent for analyzing note images and visual attachments.'},
			];

			for (const feat of features) {
				const currentAgent = this.plugin.settings.featureAgents?.[feat.id] ?? '';
				new Setting(dynamicContainer)
					.setName(feat.name)
					.setDesc(feat.desc)
					.addDropdown(dropdown => dropdown
						.addOptions(agentOptions)
						.setValue(currentAgent)
						.onChange(async (val) => {
							if (!this.plugin.settings.featureAgents) {
								this.plugin.settings.featureAgents = {...DEFAULT_SETTINGS.featureAgents};
							}
							this.plugin.settings.featureAgents[feat.id] = val;
							if (feat.id === 'search') this.plugin.settings.searchAgent = val;
							if (feat.id === 'telegram') this.plugin.settings.telegramDefaultAgent = val;
							await this.plugin.saveSettings();
						}));
			}

			new Setting(dynamicContainer)
				.setName('Agent model bindings')
				.setHeading();
			dynamicContainer.createEl('p', {
				text: 'Configure per-agent model bindings. Model bindings determine which AI model runs when the agent is invoked.',
				cls: 'setting-item-description',
			});

			if (vaultAgents.length === 0) {
				dynamicContainer.createEl('p', {
					text: 'No agents found in the vault. Features use the default agent.',
					cls: 'setting-item-description',
				});
			} else {
				for (const agent of vaultAgents) {
					new Setting(dynamicContainer)
						.setName(`Agent: ${agent.name}`)
						.setDesc(`${agent.description || 'Custom vault agent'} (${agent.filePath})`)
						.addText(text => text
							.setPlaceholder('e.g. Sonnet')
							.setValue(agent.model || '')
							.onChange(async (val) => {
								await updateAgentModelFile(this.app, agent.filePath, val);
							}));
				}
			}
		};
		void renderAgentsPanel();
	}

	/** Render the Capabilities tab. */
	private renderCapabilitiesPanel(panel: HTMLElement): void {

		new Setting(panel)
			.setName('Synapse folder')
			.setDesc(`Vault folder for agents and skills: ${SYNAPSE_FOLDER}/. Initialize installs the starter kit (Writer agent; synapse-config, obsidian, think, and writing-style skills) without overwriting existing files.`)
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const created = await installStarterKit(this.app);
						new Notice(created.length
							? `Claude Synapse starter kit installed (${created.length} files).`
							: 'Synapse starter kit is already installed — existing files were left unchanged.');
					} catch (e) {
						new Notice(`Failed to initialize synapse folder: ${String(e)}`);
					}
				}));



		new Setting(panel)
			.setName('Auto-update working directory')
			.setDesc('Automatically change the working directory to the active note\'s parent folder when switching notes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoUpdateWorkingDirectory)
				.onChange(async (value) => {
					this.plugin.settings.autoUpdateWorkingDirectory = value;
					await this.plugin.saveSettings();
				}));

		new Setting(panel)
			.setName('Auto-include note images')
			.setDesc('Automatically attach images embedded in the active note when sending a message.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoIncludeNoteImages)
				.onChange(async (value) => {
					this.plugin.settings.autoIncludeNoteImages = value;
					await this.plugin.saveSettings();
				}));

		new Setting(panel)
			.setName('Request timeout')
			.setDesc('Custom request timeout in seconds. 0 uses an adaptive default based on vault size.')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = '600';
				text.inputEl.addClass('synapse-settings-input-narrow');
				text.setValue(String(this.plugin.settings.providerRequestTimeout ?? 0))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0 && num <= 600) {
							this.plugin.settings.providerRequestTimeout = num;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(panel)
			.setName('Max note images')
			.setDesc('Maximum number of note-embedded images to auto-attach per message.')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '20';
				text.inputEl.addClass('synapse-settings-input-narrow');
				text.setValue(String(this.plugin.settings.maxNoteImages))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 1 && num <= 20) {
							this.plugin.settings.maxNoteImages = num;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(panel).setName('Chat run guardrails').setHeading();

		new Setting(panel)
			.setName('Turn limit')
			.setDesc('Auto-cancel a chat run once it reaches this many agent turns (tool-use steps), showing why. Distinct from the raw SDK turn cap. 0 = off (no limit).')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = '200';
				text.inputEl.addClass('synapse-settings-input-narrow');
				text.setValue(String(this.plugin.settings.loopTurnThreshold))
					.onChange(async (value) => {
						// Number() (not parseInt()) so scientific notation ("1e2") parses to its
						// actual value instead of being truncated at the "e", and Number.isInteger()
						// rejects fractional input outright rather than silently flooring it.
						const num = Number(value);
						if (Number.isInteger(num) && num >= 0 && num <= 200) {
							this.plugin.settings.loopTurnThreshold = num;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(panel)
			.setName('Token budget')
			.setDesc('Auto-cancel a chat run once its cumulative token usage (input + output) reaches this amount. 0 = off (no limit).')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.addClass('synapse-settings-input-medium');
				text.setValue(String(this.plugin.settings.loopTokenThreshold))
					.onChange(async (value) => {
						const num = Number(value);
						if (Number.isInteger(num) && num >= 0) {
							this.plugin.settings.loopTokenThreshold = num;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(panel)
			.setName('Dollar budget (USD)')
			.setDesc('Flag a chat run once its cost reaches this amount. Cost is only reported by the SDK after a run finishes, so this cannot stop a run in-flight — it surfaces an "over budget" notice once the total is known. Use the turn or token limit above for real-time auto-cancellation. 0 = off (no limit).')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.step = '0.01';
				text.inputEl.addClass('synapse-settings-input-medium');
				text.setValue(String(this.plugin.settings.loopCostThresholdUsd))
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.loopCostThresholdUsd = num;
							await this.plugin.saveSettings();
						}
					});
			});

	}

	/** Render the Tools tab. */
	private renderToolsPanel(panel: HTMLElement): void {

		new Setting(panel)
			.setName('Tools approval')
			.setDesc('Whether tool invocations require manual approval or are allowed automatically. For editor actions, the edit modal, and search, "ask" prompts you before a tool runs, while "allow" runs them without asking. The bot in the bots tab always runs unattended tool calls without asking, regardless of this setting — see the security policy in the repository.')
			.addDropdown(dropdown => dropdown
				.addOptions({allow: 'Allow (auto-approve)', ask: 'Ask (require approval)'})
				.setValue(this.plugin.settings.toolApproval)
				.onChange(async (value) => {
					this.plugin.settings.toolApproval = value as 'ask' | 'allow';
					await this.plugin.saveSettings();
				}));
	}

	/** Render the Bots settings tab (Telegram section). */
	private renderBotsPanel(panel: HTMLElement): void {
		// ── Telegram section ──────────────────────────────────────
		// Heading with connect/disconnect button on the right and status after label
		const headingSetting = new Setting(panel)
			.setName('Telegram')
			.setHeading();

		const statusEl = headingSetting.nameEl.createSpan({cls: 'synapse-bot-status'});

		const updateStatusDisplay = (status: string, isError = false) => {
			statusEl.empty();
			if (status) {
				statusEl.createSpan({
					text: ` — ${status}`,
					cls: isError ? 'synapse-bot-status-error' : 'synapse-bot-status-ok',
				});
			}
		};

		const telegram = this.plugin.telegramBot;
		if (telegram?.isConnected()) {
			updateStatusDisplay(`Connected as @${telegram.botUsername}`);
		}

		const updateConnectButton = () => {
			headingSetting.controlEl.empty();
			const isConnected = this.plugin.telegramBot?.isConnected() ?? false;

			if (isConnected) {
				updateStatusDisplay(`Connected as @${this.plugin.telegramBot!.botUsername}`);
				headingSetting.addButton(button => button
					.setButtonText('Disconnect')
					.setDestructive()
					.onClick(() => {
						button.setDisabled(true);
						button.setButtonText('Disconnecting…');
						try {
							this.plugin.disconnectTelegram();
							updateStatusDisplay('');
						} catch (e) {
							updateStatusDisplay(`Disconnect error: ${String(e)}`, true);
						} finally {
							updateConnectButton();
						}
					}));
			} else {
				headingSetting.addButton(button => button
					.setButtonText('Connect')
					.setCta()
					.onClick(async () => {
						const token = this.plugin.settings.telegramBotToken;
						if (!token) {
							new Notice('Please enter a bot token first.');
							return;
						}
						button.setDisabled(true);
						button.setButtonText('Connecting…');
						try {
							await this.plugin.connectTelegram();
							updateStatusDisplay(`Connected as @${this.plugin.telegramBot!.botUsername}`);
						} catch (e) {
							updateStatusDisplay(`Connection failed: ${String(e)}`, true);
						} finally {
							updateConnectButton();
						}
					}));
			}
		};

		updateConnectButton();

		const telegramWarning = panel.createDiv({cls: 'synapse-settings-warning'});
		telegramWarning.createEl('p', {
			text: 'Anyone on the allowed users list gets unattended, unapproved, full read/write agent access to this vault from their phone — messages run with permissions bypassed, no per-action approval.',
		});

		new Setting(panel)
			.setName('Bot identifier')
			.setDesc('The unique identifier for your bot.')
			.addText(text => text
				.setPlaceholder('_bot')
				.setValue(this.plugin.settings.telegramBotId)
				.onChange(async (value) => {
					this.plugin.settings.telegramBotId = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(panel)
			.setName('Bot token')
			.setDesc('The bot token (stored securely).')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.setPlaceholder('')
					.setValue(this.plugin.settings.telegramBotToken)
					.onChange((value) => {
						updateSecureField(this.app, this.plugin, 'telegramBotToken', value.trim());
					});
			});

		new Setting(panel)
			.setName('Allowed users')
			.setDesc('Comma-separated user ids that can use the bot (required).')
			.addText(text => text
				.setPlaceholder('123456789, 987654321')
				.setValue(this.plugin.settings.telegramAllowedUsers)
				.onChange(async (value) => {
					this.plugin.settings.telegramAllowedUsers = value;
					await this.plugin.saveSettings();
				}));

		// Default agent dropdown — populated from vault agents
		const agentSetting = new Setting(panel)
			.setName('Default agent')
			.setDesc('The agent used to respond to incoming messages.');

		agentSetting.addDropdown(dropdown => {
			dropdown.addOption('', 'Auto');
			// Load agents asynchronously and populate
			void scanAgents(this.app, normalizePath(`${SYNAPSE_FOLDER}/agents`)).then(agents => {
				for (const agent of agents) {
					dropdown.addOption(agent.name, agent.name);
				}
				if (this.plugin.settings.telegramDefaultAgent) {
					dropdown.setValue(this.plugin.settings.telegramDefaultAgent);
				}
			}).catch(() => { /* ignore */ });
			if (this.plugin.settings.telegramDefaultAgent) {
				dropdown.setValue(this.plugin.settings.telegramDefaultAgent);
			}
			dropdown.onChange(async (value) => {
				this.plugin.settings.telegramDefaultAgent = value;
				await this.plugin.saveSettings();
			});
		});
	}

}
