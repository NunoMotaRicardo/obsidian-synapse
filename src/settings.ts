import {App, Notice, PluginSettingTab, Setting, TFile, normalizePath} from "obsidian";
import SynapsePlugin from "./main";
import {scanAgents, scanTriggers, modifyArtifact, ensureImproveSynapseSkill} from "./configWriter";
import {fetchProviderModels, clearOllamaShowCache, describeAzureBaseUrlIssue, ProviderPreset} from "./providerModels";
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
	/** BYOK / Local provider preset. */
	providerPreset: ProviderPreset;
	/** Base URL for custom provider endpoint. */
	providerBaseUrl: string;
	/** Provider API key (stored securely via local storage). */
	providerApiKey: string;
	/** Provider bearer token (stored securely via local storage). */
	providerBearerToken: string;
	synapseFolder: string;
	toolApproval: 'ask' | 'allow';
	/** Model ID used for inline editor operations (context menu). Empty = SDK default. */
	inlineModel: string;
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
	/**
	 * Whether infinite sessions (automatic context compaction) are enabled.
	 * true (default) = SDK default behavior (omit from session config).
	 * false = explicitly disable (`infiniteSessions: { enabled: false }`).
	 */
	infiniteSessionsEnabled: boolean;
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
	/** Timestamps (epoch ms) of the last time each trigger fired, keyed by trigger name. */
	triggerLastFired: Record<string, number>;

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
	providerPreset: 'ollama',
	providerBaseUrl: 'http://localhost:11434',
	providerApiKey: '',
	providerBearerToken: '',
	synapseFolder: SYNAPSE_FOLDER,
	toolApproval: 'ask',
	inlineModel: '',
	featureAgents: {
		chat: '',
		inline: '',
		search: '',
		telegram: '',
		vision: 'Vision',
	},

	reasoningEffort: '',
	infiniteSessionsEnabled: true,
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
	triggerLastFired: {},
	loopTurnThreshold: 0,
	loopTokenThreshold: 0,
	loopCostThresholdUsd: 0,
}

/** Fields stored in vault-specific local storage instead of data.json. */
export const SECURE_FIELDS: ReadonlyArray<keyof SynapseSettings> = ['anthropicApiKey', 'telegramBotToken', 'providerApiKey', 'providerBearerToken'];

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



const SAMPLE_SKILL_CONTENT = `---
name: ascii-art
description: Generates stylized ASCII art text using block characters
---

# ASCII Art Generator

This skill generates ASCII art representations of text using block-style Unicode characters.

## Usage

When a user requests ASCII art for any word or phrase, generate the block-style representation immediately without asking for clarification on style preferences.
`;

const SAMPLE_GENERAL_AGENT = `---
name: General
description: General-purpose assistant for chat, editor operations, search, and bot tasks.
---

# General Assistant Instructions

You are a helpful general assistant for Obsidian. Help the user draft notes, answer questions, structure thoughts, and perform vault tasks.
`;

const SAMPLE_VISION_AGENT = `---
name: Vision
description: Vision-capable agent for analyzing note images, diagrams, and attachments.
---

# Vision Assistant Instructions

You are an AI assistant specialized in analyzing visual content, diagrams, images, and attachments embedded in Obsidian notes.
`;

const SAMPLE_ZETTELKASTEN_AGENT = `---
name: Zettelkasten
description: Methodology agent tuned for atomic notes, dense interlinking, and slip-box workflows.
---

# Zettelkasten Assistant Instructions

You are a Zettelkasten methodology assistant. Focus on creating atomic, single-concept notes with clear titles, rich context, and bi-directional links ([[note]]).
`;

const SAMPLE_PARA_AGENT = `---
name: PARA
description: Methodology agent tuned for Projects, Areas, Resources, and Archives organization.
---

# PARA Assistant Instructions

You are a PARA methodology assistant. Help organize information into Projects (goal-oriented), Areas (responsibilities), Resources (topics of interest), and Archives (inactive items).
`;

const SAMPLE_LYT_AGENT = `---
name: LYT
description: Methodology agent tuned for Linking Your Thinking and Maps of Content (MOCs).
---

# LYT Assistant Instructions

You are a Linking Your Thinking (LYT) methodology assistant. Help synthesize notes into Maps of Content (MOCs), facilitating fluid knowledge navigation.
`;


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

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.addClass('synapse-settings');

		// ── Tab bar ──────────────────────────────────────────────
		const tabBar = containerEl.createDiv({cls: 'synapse-settings-tab-bar'});
		const panels: Record<string, HTMLElement> = {};
		const tabButtons: Record<string, HTMLElement> = {};
		const tabIds = ['claude', 'agents', 'capabilities', 'tools', 'bots', 'triggers'] as const;
		const tabLabels: Record<string, string> = {
			claude: 'Claude',
			agents: 'Feature Map & Agents',
			capabilities: 'Capabilities',
			tools: 'Tools',
			bots: 'Bots',
			triggers: 'Triggers',
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
		tabButtons['claude']?.addClass('is-active');

		// ══════════════════════════════════════════════════════════
		// TAB 1: Claude (auth)
		// ══════════════════════════════════════════════════════════
		const claudePanel = panels['claude']!;
		const authFieldsEl = claudePanel.createDiv();

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

		new Setting(claudePanel)
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

		claudePanel.appendChild(authFieldsEl);
		renderAuthFields();

		new Setting(claudePanel)
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

		const cliStatusEl = claudePanel.createDiv({cls: 'setting-item-description synapse-settings-cli-status'});
		const cliSkewEl = claudePanel.createDiv({cls: 'setting-item-description mod-warning synapse-settings-cli-skew'});
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

		// ── Local Model / BYOK Provider ─────────────────────────────
		new Setting(claudePanel)
			.setName('Local & custom providers')
			.setHeading();

		const providerDescEl = claudePanel.createDiv({cls: 'setting-item-description synapse-settings-provider-desc'});

		const updateProviderDesc = () => {
			if (this.plugin.settings.providerPreset === 'ollama') {
				providerDescEl.setText('Ollama integration: make sure Ollama is running locally ("ollama serve"). Pull models via "ollama pull <model>". Default URL is http://localhost:11434.');
			} else if (this.plugin.settings.providerPreset === 'openai') {
				providerDescEl.setText('Works with OpenAI, OpenRouter, LM Studio, llama.cpp, vLLM, Groq, Together, DeepSeek, Mistral, Foundry Local, and anything else exposing /v1/chat/completions.');
			} else if (this.plugin.settings.providerPreset === 'azure') {
				providerDescEl.setText('Azure OpenAI: base URL must be the v1 API endpoint, https://<resource>.openai.azure.com/openai — not the bare resource endpoint, and not a classic deployment-scoped URL (…/deployments/<deployment>/…?api-version=…).');
			} else {
				providerDescEl.setText('Configure an OpenAI-compatible endpoint or BYOK provider for local or custom models.');
			}
		};
		updateProviderDesc();

		const providerFieldsEl = claudePanel.createDiv();

		const renderProviderFields = () => {
			providerFieldsEl.empty();

			const datalistId = 'synapse-provider-models-datalist';
			let datalist = providerFieldsEl.querySelector(`#${datalistId}`) as HTMLDataListElement;
			if (!datalist) {
				datalist = providerFieldsEl.createEl('datalist', {attr: {id: datalistId}});
			}

			const updateModelDatalist = (models: import('./agentService').ModelInfo[]) => {
				datalist.empty();
				for (const m of models) {
					const opt = datalist.createEl('option', {attr: {value: m.id}});
					if (m.name && m.name !== m.id) {
						opt.text = m.name;
					}
				}
			};

			new Setting(providerFieldsEl)
				.setName('Provider')
				.setDesc('Select the backend model provider preset.')
				.addDropdown(dropdown => dropdown
					.addOptions({
						ollama: 'Ollama',
						openai: 'OpenAI-compatible',
						azure: 'Azure OpenAI',
					})
					.setValue(this.plugin.settings.providerPreset)
					.onChange(async (value) => {
						this.plugin.settings.providerPreset = value as ProviderPreset;
						if (value === 'ollama' && !this.plugin.settings.providerBaseUrl) {
							this.plugin.settings.providerBaseUrl = 'http://localhost:11434';
						}
						await this.plugin.saveSettings();
						await this.plugin.initAgentService();
						updateProviderDesc();
						renderProviderFields();
					}))
				.addButton(button => button
					.setButtonText('Test')
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText('Testing…');
						clearOllamaShowCache();
						try {
							const res = await fetchProviderModels({
								preset: this.plugin.settings.providerPreset,
								baseUrl: this.plugin.settings.providerBaseUrl,
								apiKey: this.plugin.settings.providerApiKey,
								bearerToken: this.plugin.settings.providerBearerToken,
							});

							if (res.ok) {
								const models = res.models;
								if (models.length > 0) {
									let msg = `Connected — found ${models.length} model(s).`;
									if (this.plugin.settings.providerPreset === 'ollama' && !this.plugin.settings.inlineModel) {
										msg += ' Select a model in the Model name field below.';
									}
									new Notice(msg);
									this.plugin.setProviderModels(models);
									updateModelDatalist(models);
								} else {
									if (this.plugin.settings.providerPreset === 'ollama') {
										new Notice("Connected to Ollama, but no models are installed. Pull one with 'ollama pull llama3.1'.");
									} else {
										new Notice('Connected, but the provider reported no available models.');
									}
									this.plugin.setProviderModels([]);
									updateModelDatalist([]);
								}
							} else {
								const azureUrlIssue = this.plugin.settings.providerPreset === 'azure'
									? describeAzureBaseUrlIssue(this.plugin.settings.providerBaseUrl)
									: null;
								if (this.plugin.settings.providerPreset === 'ollama' && res.isOllamaConnectionError) {
									new Notice('Could not connect to Ollama. Make sure Ollama is running ("ollama serve") and the base URL is correct.');
								} else if (azureUrlIssue) {
									new Notice(azureUrlIssue);
								} else {
									new Notice(`Test failed: ${res.error}`);
								}
								this.plugin.setProviderModels([]);
								updateModelDatalist([]);
							}
						} finally {
							button.setDisabled(false);
							button.setButtonText('Test');
						}
					}));

			new Setting(providerFieldsEl)
				.setName('Base URL')
				.setDesc('Base URL for the provider endpoint.')
				.addText(text => text
					.setPlaceholder(
						this.plugin.settings.providerPreset === 'ollama' ? 'http://localhost:11434' :
						this.plugin.settings.providerPreset === 'azure' ? 'https://<resource>.openai.azure.com/openai' :
						'https://api.openai.com')
					.setValue(this.plugin.settings.providerBaseUrl)
					.onChange(async (val) => {
						this.plugin.settings.providerBaseUrl = val.trim();
						await this.plugin.saveSettings();
						await this.plugin.initAgentService();
					}));

			if (this.plugin.settings.providerPreset !== 'ollama') {
				new Setting(providerFieldsEl)
					.setName('API key')
					.setDesc('Provider API key (stored securely)')
					.addText(text => {
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.setValue(this.plugin.settings.providerApiKey)
							.onChange(async (val) => {
								updateSecureField(this.app, this.plugin, 'providerApiKey', val.trim());
								await this.plugin.initAgentService();
							});
					});
			}

			if (this.plugin.settings.providerPreset === 'ollama') {
				new Setting(providerFieldsEl)
					.setName('Bearer token')
					.setDesc('Optional — only needed for a remote or proxied Ollama, such as one behind a reverse proxy. A local Ollama needs no token, including for the cloud models it brokers. Stored securely.')
					.addText(text => {
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.setValue(this.plugin.settings.providerBearerToken)
							.onChange(async (val) => {
								updateSecureField(this.app, this.plugin, 'providerBearerToken', val.trim());
								await this.plugin.initAgentService();
							});
					});
			}

			new Setting(providerFieldsEl)
				.setName('Model name')
				.setDesc('Model name/ID for operations. Select from test results or enter custom ID.')
				.addText(text => {
					text.inputEl.setAttribute('list', datalistId);
					text.setValue(this.plugin.settings.inlineModel)
						.onChange(async (val) => {
							this.plugin.settings.inlineModel = val.trim();
							await this.plugin.saveSettings();
						});
				});
		};

		renderProviderFields();


		// ══════════════════════════════════════════════════════════
		// TAB 2: Feature Map & Agents
		// ══════════════════════════════════════════════════════════
		const agentsPanel = panels['agents']!;

		new Setting(agentsPanel)
			.setName('Feature -> Agent map')
			.setHeading();
		agentsPanel.createEl('p', {
			text: 'Map each plugin feature to a specific agent persona. Lightweight features default to a Claude model out of the box.',
			cls: 'setting-item-description',
		});

		const renderAgentsPanel = async () => {
			const dynamicContainerId = 'synapse-agents-dynamic';
			let dynamicContainer = agentsPanel.querySelector(`#${dynamicContainerId}`) as HTMLElement;
			if (dynamicContainer) {
				dynamicContainer.empty();
			} else {
				dynamicContainer = agentsPanel.createDiv({attr: {id: dynamicContainerId}});
			}

			const vaultAgents = await scanAgents(this.app, normalizePath(`${SYNAPSE_FOLDER}/agents`));
			const agentNamesSet = new Set<string>(['General', 'Vision', 'Zettelkasten', 'PARA', 'LYT', ...vaultAgents.map(a => a.name)]);
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
					text: 'No custom agents found in vault. Shipped defaults are active.',
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

		// ══════════════════════════════════════════════════════════
		// TAB 3: Capabilities
		// ══════════════════════════════════════════════════════════
		const capPanel = panels['capabilities']!;

		new Setting(capPanel)
			.setName('Synapse folder')
			.setDesc(`Vault folder for agents and skills: ${SYNAPSE_FOLDER}/`)
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const base = normalizePath(SYNAPSE_FOLDER);

						for (const sub of ['', '/agents', '/skills', '/skills/ascii-art', '/skills/improve-synapse', '/triggers']) {
							const dir = normalizePath(`${base}${sub}`);
							if (!this.app.vault.getAbstractFileByPath(dir)) {
								await this.app.vault.createFolder(dir);
							}
						}

						const sampleAgents: Array<{name: string; content: string}> = [
							{name: 'general.agent.md', content: SAMPLE_GENERAL_AGENT},
							{name: 'vision.agent.md', content: SAMPLE_VISION_AGENT},
							{name: 'zettelkasten.agent.md', content: SAMPLE_ZETTELKASTEN_AGENT},
							{name: 'para.agent.md', content: SAMPLE_PARA_AGENT},
							{name: 'lyt.agent.md', content: SAMPLE_LYT_AGENT},
						];
						for (const ag of sampleAgents) {
							const p = normalizePath(`${base}/agents/${ag.name}`);
							if (!this.app.vault.getAbstractFileByPath(p)) {
								await this.app.vault.create(p, ag.content);
							}
						}

						const skillPath = normalizePath(`${base}/skills/ascii-art/SKILL.md`);
						if (!this.app.vault.getAbstractFileByPath(skillPath)) {
							await this.app.vault.create(skillPath, SAMPLE_SKILL_CONTENT);
						}

						await ensureImproveSynapseSkill(this.app, base);

						new Notice('Synapse folder initialized with sample agents and skills.');
					} catch (e) {
						new Notice(`Failed to initialize synapse folder: ${String(e)}`);
					}
				}));



		new Setting(capPanel)
			.setName('Auto-update working directory')
			.setDesc('Automatically change the working directory to the active note\'s parent folder when switching notes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoUpdateWorkingDirectory)
				.onChange(async (value) => {
					this.plugin.settings.autoUpdateWorkingDirectory = value;
					await this.plugin.saveSettings();
				}));

		new Setting(capPanel)
			.setName('Auto-include note images')
			.setDesc('Automatically attach images embedded in the active note when sending a message.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoIncludeNoteImages)
				.onChange(async (value) => {
					this.plugin.settings.autoIncludeNoteImages = value;
					await this.plugin.saveSettings();
				}));

		new Setting(capPanel)
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

		new Setting(capPanel)
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

		new Setting(capPanel).setName('Chat run guardrails').setHeading();

		new Setting(capPanel)
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

		new Setting(capPanel)
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

		new Setting(capPanel)
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

		// ══════════════════════════════════════════════════════════
		// TAB 4: Tools
		// ══════════════════════════════════════════════════════════
		const toolsPanel = panels['tools']!;

		new Setting(toolsPanel)
			.setName('Tools approval')
			.setDesc('Whether tool invocations require manual approval or are allowed automatically. For editor actions, the edit modal, and search, "ask" prompts you before a tool runs. For unattended runs — triggers and batch loops, which have no one to ask — "ask" instead denies tool calls outright and logs the denial to that run\'s report, while "allow" runs them without asking. A trigger can override this to "allow" for just itself by setting toolApproval to allow in its own frontmatter, without changing this setting. The bot in the bots tab always runs unattended tool calls without asking, regardless of this setting — see the security policy in the repository.')
			.addDropdown(dropdown => dropdown
				.addOptions({allow: 'Allow (auto-approve)', ask: 'Ask (require approval)'})
				.setValue(this.plugin.settings.toolApproval)
				.onChange(async (value) => {
					this.plugin.settings.toolApproval = value as 'ask' | 'allow';
					await this.plugin.saveSettings();
				}));



		// ══════════════════════════════════════════════════════════
		// TAB 5: Bots
		// ══════════════════════════════════════════════════════════
		const botsPanel = panels['bots']!;
		this.renderBotsPanel(botsPanel);

		// ══════════════════════════════════════════════════════════
		// TAB 6: Triggers
		// ══════════════════════════════════════════════════════════
		const triggersPanel = panels['triggers']!;
		void this.renderTriggersPanel(triggersPanel);
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

	/** Render the Triggers settings tab. */
	private async renderTriggersPanel(panel: HTMLElement): Promise<void> {
		const triggersFolder = normalizePath(`${SYNAPSE_FOLDER}/triggers`);

		new Setting(panel)
			.setName('Triggers')
			.setHeading()
			.addButton(button => button
				.setButtonText('Open triggers folder')
				.onClick(() => {
					const folder = this.app.vault.getAbstractFileByPath(triggersFolder);
					if (folder) {
						const leaves = this.app.workspace.getLeavesOfType('file-explorer');
						const leaf = leaves[0];
						if (leaf) {
							void this.app.workspace.revealLeaf(leaf);
							(leaf.view as unknown as {revealInFolder?: (f: unknown) => void}).revealInFolder?.(folder);
						}
					} else {
						new Notice('Triggers folder not found. Initialize the Synapse folder first using the capabilities tab.');
					}
				}));

		panel.createEl('p', {
			text: 'Triggers fire automatically in response to vault events or on a schedule. Each trigger is a Markdown file in _synapse/triggers/.',
			cls: 'setting-item-description',
		});

		const listContainer = panel.createDiv({cls: 'synapse-triggers-list'});

		const renderList = async () => {
			listContainer.empty();

			const triggers = await scanTriggers(this.app, triggersFolder);

			if (triggers.length === 0) {
				listContainer.createEl('p', {
					text: 'No triggers found. Create .md files in _synapse/triggers/.',
					cls: 'setting-item-description',
				});
				return;
			}

			for (const trigger of triggers) {
				// Build type badge
				let typeBadge = '';
				if (trigger.event) {
					typeBadge = `event: ${trigger.event}`;
				} else if (trigger.schedule) {
					typeBadge = `schedule: ${trigger.schedule}`;
				}

				// Build description parts
				const descParts: string[] = [];
				if (trigger.description) descParts.push(trigger.description);
				if (typeBadge) descParts.push(typeBadge);
				if (trigger.model) descParts.push(`model: ${trigger.model}`);

				const lastFiredMs = this.plugin.settings.triggerLastFired[trigger.name];
				const lastFiredText = lastFiredMs ? formatRelativeTime(lastFiredMs) : 'Never';
				descParts.push(`Last fired: ${lastFiredText}`);

				new Setting(listContainer)
					.setName(trigger.name)
					.setDesc(descParts.join(' · '))
					.addToggle(toggle => toggle
						.setValue(trigger.enabled ?? true)
						.setTooltip(trigger.enabled ?? true ? 'Enabled' : 'Disabled')
						.onChange(async (value) => {
							await modifyArtifact(this.app, trigger.filePath, {enabled: value});
							await this.plugin.saveSettings();
						}));
			}
		};

		await renderList();
	}
}

/** Format a Unix epoch timestamp (ms) as a human-readable relative time string. */
function formatRelativeTime(timestamp: number): string {
	const diffMs = Date.now() - timestamp;
	if (diffMs < 0) return 'Just now';

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return 'Just now';

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

	const months = Math.floor(days / 30);
	return `${months} month${months === 1 ? '' : 's'} ago`;
}
