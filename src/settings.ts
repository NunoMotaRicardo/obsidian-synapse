import {App, Modal, Notice, PluginSettingTab, Setting, normalizePath} from "obsidian";
import SidekickPlugin from "./main";
import type {ModelInfo, ContextTier} from "./copilot";
import type {McpInputVariable} from "./types";
import {loadMcpInputs, loadAgents} from "./configLoader";
import {fetchProviderModels} from "./providerModels";
import type {ByokProviderPreset} from "./providerModels";
import {friendlyOllamaError} from "./ollamaErrors";

const DEFAULT_COPILOT_LOCATION = '';

/** Helper to update a secure field in both runtime settings and local storage. */
function updateSecureField(app: App, plugin: SidekickPlugin, key: keyof SidekickSettings, value: string): void {
	(plugin.settings as unknown as Record<string, unknown>)[key] = value;
	saveSecureField(app, key, value);
}

export interface SidekickSettings {
	/** 'local' uses cliPath, 'remote' uses cliUrl. */
	copilotType: 'local' | 'remote';
	copilotLocation: string;
	/** URL of an existing CLI server to connect to. */
	cliUrl: string;
	/** Use the logged-in GitHub user for auth (local mode). */
	useLoggedInUser: boolean;
	/** GitHub personal access token (used when useLoggedInUser is false or in remote mode). */
	githubToken: string;
	sidekickFolder: string;
	toolApproval: 'ask' | 'allow';
	/** Model ID used for inline editor operations (context menu). Empty = SDK default. */
	inlineModel: string;
	/** Enable ghost-text autocomplete in the editor. */
	autocompleteEnabled: boolean;
	/** Show the inline Sidekick icon on the active editor line. */
	inlineIconEnabled: boolean;
	/** Provider preset for BYOK. 'github' uses built-in auth. */
	providerPreset: 'github' | 'openai' | 'azure' | 'anthropic' | 'ollama' | 'foundry-local' | 'other-openai';
	/** Base URL for the BYOK provider endpoint. */
	providerBaseUrl: string;
	/** API key for the BYOK provider. */
	providerApiKey: string;
	/** Bearer token for the BYOK provider. */
	providerBearerToken: string;
	/** Wire API format: completions or responses. */
	providerWireApi: 'completions' | 'responses';
	/** Model name/ID to use with a BYOK provider. */
	providerModel: string;
	/** Max prompt tokens for BYOK providers (0 = provider default). Controls SDK-side compaction. */
	providerMaxPromptTokens: number;
	/** Request timeout in seconds for BYOK providers (0 = SDK default 60s). */
	providerRequestTimeout: number;
	/** Persisted form defaults for the Edit modal. */
	editModalDefaults?: EditModalDefaults;
	/** Custom display names for sessions, keyed by SDK sessionId. */
	sessionNames?: Record<string, string>;
	/** Last-fired timestamps for trigger deduplication, keyed by trigger name. */
	triggerLastFired?: Record<string, number>;
	/** Stored values for non-password MCP input variables, keyed by input id. */
	mcpInputValues?: Record<string, string>;
	/**
	 * Reasoning effort level for model inference. '' = model default.
	 * Stored as a free string because models report values beyond the SDK's
	 * `ReasoningEffort` union (e.g. 'max', 'none'); validity is enforced against
	 * `model.supportedReasoningEfforts` at render time.
	 */
	reasoningEffort: string;
	/**
	 * Reasoning summary mode. '' = model default; otherwise 'none' | 'concise' |
	 * 'detailed' (SDK `ReasoningSummary`). 'none' suppresses reasoning output.
	 */
	reasoningSummary: string;
	/**
	 * Context-window tier for the session. 'default' = model default; 'long_context'
	 * pins the session to the long-context tier when the selected model supports it
	 * (the SDK silently ignores it otherwise). Omitted from session config when 'default',
	 * matching the reasoning omit-when-empty pattern. There is no per-model support signal
	 * in the SDK, so the toggle is always shown.
	 */
	contextTier: ContextTier;
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

export const DEFAULT_SETTINGS: SidekickSettings = {
	copilotType: 'local',
	copilotLocation: DEFAULT_COPILOT_LOCATION,
	cliUrl: '',
	useLoggedInUser: true,
	githubToken: '',
	sidekickFolder: 'sidekick',
	toolApproval: 'ask',
	inlineModel: '',
	autocompleteEnabled: false,
	inlineIconEnabled: false,
	providerPreset: 'github',
	providerBaseUrl: '',
	providerApiKey: '',
	providerBearerToken: '',
	providerWireApi: 'completions',
	providerModel: '',
	providerMaxPromptTokens: 0,
	providerRequestTimeout: 0,
	reasoningEffort: '',
	reasoningSummary: '',
	contextTier: 'default',
	infiniteSessionsEnabled: true,
	searchAgent: '',
	searchMode: 'basic',
	autoUpdateWorkingDirectory: false,
	autoIncludeNoteImages: true,
	maxNoteImages: 3,
	telegramBotId: '',
	telegramBotToken: '',
	telegramAllowedUsers: '',
	telegramDefaultAgent: '',
}

/** Fields stored in vault-specific local storage instead of data.json. */
export const SECURE_FIELDS: ReadonlyArray<keyof SidekickSettings> = ['githubToken', 'providerApiKey', 'providerBearerToken', 'telegramBotToken'];

const SECURE_PREFIX = 'sidekick-secure-';

/** Load a secure field from vault-specific local storage. */
export function loadSecureField(app: App, key: string): string {
	const stored = app.loadLocalStorage(SECURE_PREFIX + key);
	return stored != null ? String(stored) : '';
}

/** Save a secure field to vault-specific local storage. */
export function saveSecureField(app: App, key: string, value: string): void {
	app.saveLocalStorage(SECURE_PREFIX + key, value || null);
}

/** Derive the agents subfolder from the base Sidekick folder. */
export function getAgentsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/agents`);
}

/** Derive the skills subfolder from the base Sidekick folder. */
export function getSkillsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/skills`);
}

/** Derive the tools subfolder from the base Sidekick folder. */
export function getToolsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/tools`);
}

/** Derive the prompts subfolder from the base Sidekick folder. */
export function getPromptsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/prompts`);
}

/** Derive the triggers subfolder from the base Sidekick folder. */
export function getTriggersFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/triggers`);
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

const SAMPLE_AGENT_CONTENT = `---
name: Grammar
description: The Grammar Assistant agent helps users improve their writing
tools:
  - github
skills:
  - ascii-art
model: Claude Sonnet 4.5
---

# Grammar Assistant agent Instructions

You are the **Grammar Assistant agent** - the primary task is to helps users improve their writing
`;

const SAMPLE_PROMPT_CONTENT = `---
agent: Grammar
---
Translate the provided text from English to Portuguese.
`;

const SAMPLE_TRIGGER_CONTENT = `---
name: Daily planner
description: Prepares a plan for the day every morning at 8am
agent: Planner
cron: "0 8 * * *"
glob: "**/*.md"
enabled: true
---
Help me prepare my day, including asks on me, recommendations for clear actions to prepare, and suggestions on which items to prioritize over others.
`;

export class SidekickSettingTab extends PluginSettingTab {
	plugin: SidekickPlugin;

	constructor(app: App, plugin: SidekickPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.addClass('sidekick-settings');

		// ── Tab bar ──────────────────────────────────────────────
		const tabBar = containerEl.createDiv({cls: 'sidekick-settings-tab-bar'});
		const panels: Record<string, HTMLElement> = {};
		const tabButtons: Record<string, HTMLElement> = {};
		const tabIds = ['copilot', 'models', 'capabilities', 'tools', 'bots'] as const;
		const tabLabels: Record<string, string> = {
			copilot: 'Copilot',
			models: 'Models',
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
				cls: 'sidekick-settings-tab',
				text: tabLabels[id],
			});
			btn.addEventListener('click', () => switchSettingsTab(id));
			tabButtons[id] = btn;
		}

		// ── Panels ───────────────────────────────────────────────
		const toolsFolder = normalizePath(`${this.plugin.settings.sidekickFolder}/tools`);
		if (!this.app.vault.getAbstractFileByPath(toolsFolder)) {
			const warning = containerEl.createDiv({cls: 'sidekick-settings-warning'});
			warning.createEl('p', {
				text: 'Sidekick folder is not initialized. Go to the capabilities tab to configure and initialize it.',
			});
		}

		for (const id of tabIds) {
			panels[id] = containerEl.createDiv({cls: `sidekick-settings-panel${id === 'copilot' ? '' : ' is-hidden'}`});
		}
		tabButtons['copilot']?.addClass('is-active');

		// Hoisted so the Test button and Models section can both reference it
		let refreshModels: () => Promise<void> = async () => {};
		let inlineModelSelect: HTMLSelectElement | null = null;

		// Model name datalist: in-memory only, populated by a successful BYOK
		// Test, reset to empty whenever the Settings tab is (re)opened.
		const MODEL_DATALIST_ID = 'sidekick-provider-model-datalist';
		let modelDatalistEl: HTMLDataListElement | null = null;

		const populateModelDatalist = (models: ModelInfo[]) => {
			if (!modelDatalistEl) return;
			modelDatalistEl.empty();
			for (const model of models) {
				const option = modelDatalistEl.createEl('option', {value: model.id});
				if (model.name && model.name !== model.id) {
					option.label = model.name;
				}
			}
		};

		const populateInlineDropdown = (models: ModelInfo[]) => {
			if (inlineModelSelect) {
				const prev = this.plugin.settings.inlineModel;
				inlineModelSelect.empty();
				const defOpt = inlineModelSelect.createEl('option', {text: 'Default (SDK default)'});
				defOpt.value = '';
				for (const model of models) {
					const opt = inlineModelSelect.createEl('option', {text: model.name});
					opt.value = model.id;
				}
				const ids = models.map(m => m.id);
				inlineModelSelect.value = (prev && ids.includes(prev)) ? prev : '';
				if (inlineModelSelect.value !== prev) {
					this.plugin.settings.inlineModel = inlineModelSelect.value;
					void this.plugin.saveSettings();
				}
			}
		};

		refreshModels = async () => {
			try {
				const preset = this.plugin.settings.providerPreset;
				const isByok = preset !== 'github';
				if (isByok) {
					// Synchronous first: populate the dropdown immediately with the
					// configured model so the UI renders instantly without waiting
					// for a network call (which may hang if e.g. Ollama is down).
					const initialModels: ModelInfo[] = [];
					if (this.plugin.settings.providerModel) {
						const id = this.plugin.settings.providerModel;
						initialModels.push({id, name: id} as ModelInfo);
						this.plugin.settings.inlineModel = id;
						await this.plugin.saveSettings();
					}
					populateInlineDropdown(initialModels);

					// Background fetch: try to get the full model list from the
					// provider. If it succeeds, update the dropdown. If it fails
					// (e.g. provider not running), the dropdown keeps the
					// configured model from above.
					if (this.plugin.settings.providerBaseUrl) {
						void fetchProviderModels({
							preset: preset as Parameters<typeof fetchProviderModels>[0]['preset'],
							baseUrl: this.plugin.settings.providerBaseUrl,
							apiKey: this.plugin.settings.providerApiKey,
							bearerToken: this.plugin.settings.providerBearerToken,
						}).then((result) => {
							if (result.ok && result.models.length > 0) {
								populateInlineDropdown(result.models);
								this.plugin.notifySidebarModelsChanged(result.models);
								// Pre-select the configured model if present
								if (this.plugin.settings.providerModel) {
									const ids = result.models.map(m => m.id);
									if (ids.includes(this.plugin.settings.providerModel)) {
										this.plugin.settings.inlineModel = this.plugin.settings.providerModel;
									} else if (result.models[0]) {
										this.plugin.settings.inlineModel = result.models[0].id;
									}
									void this.plugin.saveSettings();
								}
							}
						}).catch(() => {
							// silently ignore — dropdown keeps the configured model
						});
					}
				} else if (this.plugin.copilot) {
					const models: ModelInfo[] = await this.plugin.copilot.listModels();
					populateInlineDropdown(models);
					this.plugin.notifySidebarModelsChanged(models);
				}
			} catch {
				// silently ignore — dropdown keeps its placeholder
			}
		};

		// ══════════════════════════════════════════════════════════
		// TAB 1: Copilot client
		// ══════════════════════════════════════════════════════════
		const copilotPanel = panels['copilot']!;
		const clientFieldsEl = copilotPanel.createDiv();

		const renderClientFields = () => {
			clientFieldsEl.empty();
			const isRemote = this.plugin.settings.copilotType === 'remote';

			if (isRemote) {
				new Setting(clientFieldsEl)
					.setName('URL')
					.setDesc('URL of existing CLI server to connect to.')
					.addText(text => text
						.setPlaceholder('Ex: localhost:8080')
						.setValue(this.plugin.settings.cliUrl)
						.onChange(async (value) => {
							this.plugin.settings.cliUrl = value.trim();
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
						}));

				new Setting(clientFieldsEl)
					.setName('GitHub token')
					.setDesc('GitHub token for authentication (stored securely).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.setPlaceholder('')
							.setValue(this.plugin.settings.githubToken)
							.onChange(async (value) => {
								updateSecureField(this.app, this.plugin, 'githubToken', value.trim());
								await this.plugin.initCopilot();
							});
					});
			} else {
				new Setting(clientFieldsEl)
					.setName('Path')
					.setDesc('Path to copilot executable.')
					.addText(text => text
						.setPlaceholder('Leave blank for default')
						.setValue(this.plugin.settings.copilotLocation)
						.onChange(async (value) => {
							const sanitized = value.trim();
							if (/[;|&`$(){}]/.test(sanitized)) {
								new Notice('Copilot location contains invalid characters.');
								return;
							}
							this.plugin.settings.copilotLocation = sanitized;
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
							void showResolvedBinaryPath();
						}));

				const resolvedSetting = new Setting(clientFieldsEl)
					.setName('Resolved binary')
					.setDesc('Resolving\u2026');
				resolvedSetting.descEl.addClass('sidekick-resolved-binary');
				const showResolvedBinaryPath = async () => {
					try {
						const copilot = this.plugin.copilot;
						if (!copilot) { resolvedSetting.setDesc('Copilot service is not initialized.'); return; }
						const resolved = await copilot.resolveCliPath();
						const labels: Record<string, string> = {
							'settings': 'from path setting',
							'global-npm': 'from global npm install',
							'winget': 'from WinGet',
							'js-fallback': 'JS entry-point fallback',
						};
						resolvedSetting.descEl.empty();
						if (!resolved) {
							resolvedSetting.setDesc('Could not resolve binary path.');
							return;
						}
						resolvedSetting.descEl.createEl('code', {text: resolved.path});
						const versionInfo = copilot.getVersionInfo();
						const versionSuffix = versionInfo
							? ` — v${versionInfo.version}, protocol ${versionInfo.protocolVersion}`
							: '';
						resolvedSetting.descEl.createSpan({text: ` (${labels[resolved.source] ?? resolved.source})${versionSuffix}`});
					} catch {
						resolvedSetting.setDesc('Could not resolve binary path.');
					}
				};
				void showResolvedBinaryPath();

				new Setting(clientFieldsEl)
					.setName('Use logged\u2011in user')
					.setDesc('Whether to use logged-in user for authentication.')
					.addToggle(toggle => toggle
						.setValue(this.plugin.settings.useLoggedInUser)
						.onChange(async (value) => {
							this.plugin.settings.useLoggedInUser = value;
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
							renderClientFields();
						}));

				if (!this.plugin.settings.useLoggedInUser) {
					new Setting(clientFieldsEl)
						.setName('GitHub token')
						.setDesc('GitHub token for authentication (stored securely).')
						.addText(text => {
							text.inputEl.type = 'password';
							text.inputEl.autocomplete = 'off';
							text.setPlaceholder('')
								.setValue(this.plugin.settings.githubToken)
								.onChange(async (value) => {
									updateSecureField(this.app, this.plugin, 'githubToken', value.trim());
									await this.plugin.initCopilot();
								});
						});
				}
			}
		};

		new Setting(copilotPanel)
			.setName('Client type')
			.setDesc('Use a local or remote copilot client.')
			.addDropdown(dropdown => dropdown
				.addOptions({local: 'Local CLI', remote: 'Remote CLI'})
				.setValue(this.plugin.settings.copilotType)
				.onChange(async (value) => {
					this.plugin.settings.copilotType = value as 'local' | 'remote';
					await this.plugin.saveSettings();
					await this.plugin.initCopilot();
					renderClientFields();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const result = await this.plugin.copilot.ping();
						new Notice(`Copilot connected: ${result.message}`);
						await refreshModels();
					} catch (e) {
						new Notice(`Test failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		copilotPanel.appendChild(clientFieldsEl);
		renderClientFields();

		// ══════════════════════════════════════════════════════════
		// TAB 2: Models
		// ══════════════════════════════════════════════════════════
		const modelsPanel = panels['models']!;
		const providerFieldsEl = modelsPanel.createDiv();

		const providerDefaults: Record<string, {baseUrl?: string; wireApi?: 'completions' | 'responses'; requestTimeout?: number}> = {
			openai:          {baseUrl: 'https://api.openai.com/v1'},
			azure:           {baseUrl: 'https://your-resource.openai.azure.com/openai/v1/', wireApi: 'responses'},
			anthropic:       {baseUrl: 'https://api.anthropic.com'},
			ollama:          {baseUrl: 'http://localhost:11434/v1', requestTimeout: 120},
			'foundry-local': {baseUrl: 'http://localhost:<PORT>/v1'},
		};

		const rebuildProviderFields = () => {
			providerFieldsEl.empty();
			const preset = this.plugin.settings.providerPreset;
			const isByok = preset !== 'github';

			if (isByok) {
				const defaults = providerDefaults[preset];
				const placeholderUrl = defaults?.baseUrl ?? 'https://api.example.com/v1';

				new Setting(providerFieldsEl)
					.setName('Base URL')
					.setDesc('Provider API endpoint (required).')
					.addText(text => text
						.setPlaceholder(placeholderUrl)
						.setValue(this.plugin.settings.providerBaseUrl)
						.onChange(async (value) => {
							this.plugin.settings.providerBaseUrl = value.trim();
							await this.plugin.saveSettings();
						}));

				new Setting(providerFieldsEl)
					.setName('Model name')
					.setDesc('Ex: gpt-4o, claude-sonnet-4, etc. (test to populate suggestions)')
					.addText(text => {
						text.setPlaceholder('')
							.setValue(this.plugin.settings.providerModel)
							.onChange(async (value) => {
								this.plugin.settings.providerModel = value.trim();
								await this.plugin.saveSettings();
								await refreshModels();
							});
						text.inputEl.setAttribute('list', MODEL_DATALIST_ID);
						modelDatalistEl = (text.inputEl.parentElement ?? providerFieldsEl).createEl('datalist', {attr: {id: MODEL_DATALIST_ID}});
						populateModelDatalist([]);
						// Auto-fetch model list in background when settings open
						if (this.plugin.settings.providerBaseUrl) {
							void fetchProviderModels({
								preset: this.plugin.settings.providerPreset as ByokProviderPreset,
								baseUrl: this.plugin.settings.providerBaseUrl,
								apiKey: this.plugin.settings.providerApiKey,
								bearerToken: this.plugin.settings.providerBearerToken,
							}).then(result => {
								if (result.ok && result.models.length > 0) {
									populateModelDatalist(result.models);
								}
							}).catch(() => { /* keep empty — user can click Test */ });
						}
					});

				new Setting(providerFieldsEl)
					.setName('API key')
					.setDesc('Sent as optional header (stored securely).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.setPlaceholder('')
							.setValue(this.plugin.settings.providerApiKey)
							.onChange((value) => {
								updateSecureField(this.app, this.plugin, 'providerApiKey', value.trim());
							});
					});

				new Setting(providerFieldsEl)
					.setName('Bearer token')
					.setDesc('Authorization optional token header (stored securely).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.setPlaceholder('')
							.setValue(this.plugin.settings.providerBearerToken)
							.onChange((value) => {
								updateSecureField(this.app, this.plugin, 'providerBearerToken', value.trim());
							});
					});

				new Setting(providerFieldsEl)
					.setName('Wire API')
					.setDesc('API format to use.')
					.addDropdown(dropdown => dropdown
						.addOptions({completions: 'Completions', responses: 'Responses'})
						.setValue(this.plugin.settings.providerWireApi)
						.onChange(async (value) => {
							this.plugin.settings.providerWireApi = value as 'completions' | 'responses';
							await this.plugin.saveSettings();
						}));

				new Setting(providerFieldsEl)
					.setName('Context window (tokens)')
					.setDesc('Max prompt tokens before conversation history is compacted. 0 = provider default. For Ollama, also increase num_ctx on the server.')
					.addText(text => text
						.setPlaceholder('0')
						.setValue(this.plugin.settings.providerMaxPromptTokens ? String(this.plugin.settings.providerMaxPromptTokens) : '')
						.onChange(async (value) => {
							const n = parseInt(value.trim(), 10);
							this.plugin.settings.providerMaxPromptTokens = (Number.isFinite(n) && n > 0) ? n : 0;
							await this.plugin.saveSettings();
						}));

				new Setting(providerFieldsEl)
					.setName('Request timeout (seconds)')
					.setDesc('Max time to wait for a model response. 0 = default (60s). Increase for slow models (e.g. Ollama vision).')
					.addText(text => text
						.setPlaceholder('0')
						.setValue(this.plugin.settings.providerRequestTimeout ? String(this.plugin.settings.providerRequestTimeout) : '')
						.onChange(async (value) => {
							const n = parseInt(value.trim(), 10);
							this.plugin.settings.providerRequestTimeout = (Number.isFinite(n) && n > 0) ? n : 0;
							await this.plugin.saveSettings();
						}));
			}
		};

		const providerOptions: Record<string, string> = {
			github: 'GitHub (built-in)',
			openai: 'OpenAI',
			azure: 'Microsoft Foundry',
			anthropic: 'Anthropic',
			ollama: 'Ollama',
			'foundry-local': 'Microsoft Foundry Local',
			'other-openai': 'Other OpenAI-compatible',
		};

		const providerSetting = new Setting(modelsPanel)
			.setName('Provider')
			.setDesc('Use the built-in models or configure your own (local or remote).');

		const updateProviderDesc = (preset: string) => {
			if (preset === 'ollama') {
				providerSetting.setDesc(
					'Ollama runs models locally. Install from ollama.com, start the server ("ollama serve"), ' +
					'pull a model ("ollama pull llama3.1"), then click Test to verify.'
				);
			} else {
				providerSetting.setDesc('Use the built-in models or configure your own (local or remote).');
			}
		};
		updateProviderDesc(this.plugin.settings.providerPreset);

		providerSetting.addDropdown(dropdown => dropdown
				.addOptions(providerOptions)
				.setValue(this.plugin.settings.providerPreset)
				.onChange(async (value) => {
					const newPreset = value as SidekickSettings['providerPreset'];
					this.plugin.settings.providerPreset = newPreset;
					const defaults = providerDefaults[newPreset];
					if (defaults?.baseUrl) {
						this.plugin.settings.providerBaseUrl = defaults.baseUrl;
					} else if (newPreset === 'github') {
						this.plugin.settings.providerBaseUrl = '';
					}
					this.plugin.settings.providerWireApi = defaults?.wireApi ?? 'completions';
					this.plugin.settings.providerRequestTimeout = defaults?.requestTimeout ?? 0;
					if (newPreset === 'github') {
						this.plugin.settings.providerModel = '';
						this.plugin.settings.inlineModel = '';
					}
					await this.plugin.saveSettings();
					updateProviderDesc(newPreset);
					rebuildProviderFields();
					await refreshModels();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						const preset = this.plugin.settings.providerPreset;
						if (preset === 'github') {
							if (!this.plugin.copilot) {
								throw new Error('Copilot service is not available');
							}
							const testSession = await this.plugin.copilot.createSession({
								onPermissionRequest: () => ({allow: false, kind: 'denied-interactively-by-user' as const}),
							});
							await testSession.disconnect();
							new Notice('Provider session created successfully.');
							await refreshModels();
							return;
						}

						if (!this.plugin.settings.providerBaseUrl) {
							throw new Error('Base URL is required');
						}
						const result = await fetchProviderModels({
							preset,
							baseUrl: this.plugin.settings.providerBaseUrl,
							apiKey: this.plugin.settings.providerApiKey,
							bearerToken: this.plugin.settings.providerBearerToken,
						});
						const isOllama = preset === 'ollama';
						if (!result.ok) {
							populateModelDatalist([]);
							const friendly = isOllama ? friendlyOllamaError(result.error) : null;
							if (friendly) {
								new Notice(friendly);
							} else {
								new Notice(`Test failed: ${result.error}`);
							}
						} else if (result.models.length === 0) {
							populateModelDatalist([]);
							if (isOllama) {
								new Notice('Connected to Ollama, but no models are installed. Pull one with "ollama pull llama3.1".');
							} else {
								new Notice('Connected, but the provider reported no available models.');
							}
						} else {
							populateModelDatalist(result.models);
							const modelMsg = `Connected — found ${result.models.length} model(s).`;
							if (isOllama && !this.plugin.settings.providerModel) {
								new Notice(`${modelMsg} Select a model in the Model name field below.`);
							} else {
								new Notice(modelMsg);
							}
						}
						await refreshModels();
					} catch (e) {
						populateModelDatalist([]);
						const isOllamaCatch = this.plugin.settings.providerPreset === 'ollama';
						const friendlyCatch = isOllamaCatch ? friendlyOllamaError(String(e)) : null;
						if (friendlyCatch) {
							new Notice(friendlyCatch);
						} else {
							new Notice(`Test failed: ${String(e)}`);
						}
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		modelsPanel.appendChild(providerFieldsEl);
		rebuildProviderFields();

		new Setting(modelsPanel)
			.setName('Inline operations model')
			.setDesc('Model used for editor context-menu actions (fix grammar, summarize, etc.).')
			.addDropdown(dropdown => {
				inlineModelSelect = dropdown.selectEl;
				dropdown.addOption('', 'Default (SDK default)');
				if (this.plugin.settings.inlineModel) {
					dropdown.addOption(this.plugin.settings.inlineModel, this.plugin.settings.inlineModel);
					dropdown.setValue(this.plugin.settings.inlineModel);
				}
				dropdown.onChange(async (value) => {
					this.plugin.settings.inlineModel = value;
					await this.plugin.saveSettings();
				});
			});

		// ══════════════════════════════════════════════════════════
		// TAB 3: Capabilities
		// ══════════════════════════════════════════════════════════
		const capPanel = panels['capabilities']!;

		new Setting(capPanel)
			.setName('Sidekick folder')
			.setDesc('Vault folder for agents, skills, tools and triggers.')
			.addText(text => text
				.setPlaceholder('Ex: sidekick')
				.setValue(this.plugin.settings.sidekickFolder)
				.onChange(async (value) => {
					const sanitized = value.trim().replace(/\.\./g, '');
					if (!sanitized || /[;|&`$(){}]/.test(sanitized)) {
						new Notice('Sidekick folder name is invalid.');
						return;
					}
					this.plugin.settings.sidekickFolder = sanitized;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const base = normalizePath(this.plugin.settings.sidekickFolder);

						for (const sub of ['', '/agents', '/skills', '/skills/ascii-art', '/tools', '/prompts', '/triggers']) {
							const dir = normalizePath(`${base}${sub}`);
							if (!this.app.vault.getAbstractFileByPath(dir)) {
								await this.app.vault.createFolder(dir);
							}
						}

						const agentPath = normalizePath(`${base}/agents/grammar.agent.md`);
						if (!this.app.vault.getAbstractFileByPath(agentPath)) {
							await this.app.vault.create(agentPath, SAMPLE_AGENT_CONTENT);
						}

						const skillPath = normalizePath(`${base}/skills/ascii-art/SKILL.md`);
						if (!this.app.vault.getAbstractFileByPath(skillPath)) {
							await this.app.vault.create(skillPath, SAMPLE_SKILL_CONTENT);
						}

						const mcpPath = normalizePath(`${base}/tools/mcp.json`);
						if (!this.app.vault.getAbstractFileByPath(mcpPath)) {
							const mcpContent = JSON.stringify({
								servers: {
									github: {
										type: 'http',
										url: 'https://api.githubcopilot.com/mcp/'
									}
								}
							}, null, '\t');
							await this.app.vault.create(mcpPath, mcpContent);
						}

						const promptPath = normalizePath(`${base}/prompts/en-to-pt.prompt.md`);
						if (!this.app.vault.getAbstractFileByPath(promptPath)) {
							await this.app.vault.create(promptPath, SAMPLE_PROMPT_CONTENT);
						}

						const triggerPath = normalizePath(`${base}/triggers/daily-planner.trigger.md`);
						if (!this.app.vault.getAbstractFileByPath(triggerPath)) {
							await this.app.vault.create(triggerPath, SAMPLE_TRIGGER_CONTENT);
						}

						new Notice('Sidekick folder initialized with sample agent, skill, prompt, trigger, and mcp.json.');
					} catch (e) {
						new Notice(`Failed to initialize sidekick folder: ${String(e)}`);
					}
				}));

		new Setting(capPanel)
			.setName('Enable ghost-text autocomplete')
			.setDesc('Show inline suggestions as you type (uses the inline operations model).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autocompleteEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autocompleteEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(capPanel)
			.setName('Show inline Sidekick icon')
			.setDesc('Show the Sidekick icon in the editor gutter next to the active line.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.inlineIconEnabled)
				.onChange(async (value) => {
					this.plugin.settings.inlineIconEnabled = value;
					await this.plugin.saveSettings();
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
			.setName('Max note images')
			.setDesc('Maximum number of note-embedded images to auto-attach per message.')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '20';
				text.inputEl.style.width = '60px';
				text.setValue(String(this.plugin.settings.maxNoteImages))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 1 && num <= 20) {
							this.plugin.settings.maxNoteImages = num;
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
			.setDesc('Whether tool invocations require manual approval or are allowed automatically.')
			.addDropdown(dropdown => dropdown
				.addOptions({allow: 'Allow (auto-approve)', ask: 'Ask (require approval)'})
				.setValue(this.plugin.settings.toolApproval)
				.onChange(async (value) => {
					this.plugin.settings.toolApproval = value as 'ask' | 'allow';
					await this.plugin.saveSettings();
				}));

		// ── MCP input variables (always visible) ─────────────────
		new Setting(toolsPanel)
			.setName('Input variables')
			.setHeading();

		const mcpInputsEl = toolsPanel.createDiv();
		const renderMcpInputs = async () => {
			mcpInputsEl.empty();
			new Setting(mcpInputsEl)
				.setDesc('Manage values for input variables defined in mcp.json. Password inputs are stored securely.');

			let inputs: McpInputVariable[] = [];
			try {
				inputs = await loadMcpInputs(this.app, getToolsFolder(this.plugin.settings));
			} catch {
				// mcp.json may not exist yet
			}

			if (inputs.length === 0) {
				mcpInputsEl.createEl('p', {
					text: 'No input variables defined in mcp.json.',
					cls: 'setting-item-description',
				});
			} else {
				for (const input of inputs) {
					const isPassword = input.password === true;
					const currentValue = getMcpInputValue(this.app, this.plugin, input.id, isPassword);
					new Setting(mcpInputsEl)
						.setName(input.id)
						.setDesc(input.description + (isPassword ? ' (password — stored securely)' : ''))
						.addText(text => {
							if (isPassword) {
								text.inputEl.type = 'password';
								text.inputEl.autocomplete = 'off';
							}
							text.setPlaceholder('Enter value…')
								.setValue(currentValue ?? '')
								.onChange(async (value) => {
									await setMcpInputValue(this.app, this.plugin, input.id, value, isPassword);
								});
						})
						.addExtraButton(button => button
							.setIcon('trash')
							.setTooltip('Delete stored value')
							.onClick(async () => {
								await deleteMcpInputValue(this.app, this.plugin, input.id, isPassword);
								await renderMcpInputs();
								new Notice(`Deleted value for input "${input.id}".`);
							}));
				}
			}
		};
		void renderMcpInputs();

		// ══════════════════════════════════════════════════════════
		// TAB 5: Bots
		// ══════════════════════════════════════════════════════════
		const botsPanel = panels['bots']!;
		this.renderBotsPanel(botsPanel);

		// Auto-refresh models when opening settings
		void refreshModels();
	}

	/** Render the Bots settings tab (Telegram section). */
	private renderBotsPanel(panel: HTMLElement): void {
		// ── Telegram section ──────────────────────────────────────
		// Heading with connect/disconnect button on the right and status after label
		const headingSetting = new Setting(panel)
			.setName('Telegram')
			.setHeading();

		const statusEl = headingSetting.nameEl.createSpan({cls: 'sidekick-bot-status'});

		const updateStatusDisplay = (status: string, isError = false) => {
			statusEl.empty();
			if (status) {
				statusEl.createSpan({
					text: ` — ${status}`,
					cls: isError ? 'sidekick-bot-status-error' : 'sidekick-bot-status-ok',
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
					.setWarning()
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
			void loadAgents(this.app, getAgentsFolder(this.plugin.settings)).then(agents => {
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

// ── MCP Input value helpers ─────────────────────────────────

const MCP_SECRET_PREFIX = 'sidekick-mcp-input-';

/** Retrieve the stored value for an MCP input variable. */
export function getMcpInputValue(app: App, plugin: SidekickPlugin, id: string, isPassword: boolean): string | undefined {
	if (isPassword) {
		const stored = app.loadLocalStorage(MCP_SECRET_PREFIX + id);
		return stored != null ? String(stored) : undefined;
	}
	return plugin.settings.mcpInputValues?.[id];
}

/** Store a value for an MCP input variable. */
export async function setMcpInputValue(app: App, plugin: SidekickPlugin, id: string, value: string, isPassword: boolean): Promise<void> {
	if (isPassword) {
		app.saveLocalStorage(MCP_SECRET_PREFIX + id, value);
	} else {
		if (!plugin.settings.mcpInputValues) plugin.settings.mcpInputValues = {};
		plugin.settings.mcpInputValues[id] = value;
		await plugin.saveSettings();
	}
}

/** Delete the stored value for an MCP input variable. */
export async function deleteMcpInputValue(app: App, plugin: SidekickPlugin, id: string, isPassword: boolean): Promise<void> {
	if (isPassword) {
		app.saveLocalStorage(MCP_SECRET_PREFIX + id, null);
	} else {
		if (plugin.settings.mcpInputValues) {
			delete plugin.settings.mcpInputValues[id];
			await plugin.saveSettings();
		}
	}
}

/**
 * Modal that prompts the user to provide a value for a missing MCP input variable.
 */
export class McpInputPromptModal extends Modal {
	private readonly input: McpInputVariable;
	private readonly onSubmit: (value: string | undefined) => void;

	constructor(app: App, input: McpInputVariable, onSubmit: (value: string | undefined) => void) {
		super(app);
		this.input = input;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.createEl('h3', {text: 'Input required'});
		contentEl.createEl('p', {text: this.input.description});
		contentEl.createEl('p', {text: `Variable: ${this.input.id}`, cls: 'setting-item-description'});

		let inputValue = '';
		new Setting(contentEl)
			.setName('Value')
			.addText(text => {
				if (this.input.password) {
					text.inputEl.type = 'password';
					text.inputEl.autocomplete = 'off';
				}
				text.setPlaceholder('Enter value…')
					.onChange(v => { inputValue = v; });
				// Focus input after render
				setTimeout(() => text.inputEl.focus(), 50);
			});

		const btnRow = contentEl.createDiv({cls: 'modal-button-container'});
		const saveBtn = btnRow.createEl('button', {text: 'Save', cls: 'mod-cta'});
		saveBtn.addEventListener('click', () => {
			this.close();
			this.onSubmit(inputValue || undefined);
		});
		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => {
			this.close();
			this.onSubmit(undefined);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
