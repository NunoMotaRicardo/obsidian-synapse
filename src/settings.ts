import {App, Modal, Notice, PluginSettingTab, Setting, TFile, normalizePath} from "obsidian";
import SynapsePlugin from "./main";
import type {ContextTier} from "./copilot";
import type {McpInputVariable} from "./types";
import {loadMcpInputs, loadAgents} from "./configLoader";

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
	synapseFolder: string;
	toolApproval: 'ask' | 'allow';
	/** Model ID used for inline editor operations (context menu). Empty = SDK default. */
	inlineModel: string;
	/** Feature to Agent mapping for plugin features. */
	featureAgents: FeatureAgentMap;
	/** Enable ghost-text autocomplete in the editor. */
	autocompleteEnabled: boolean;
	/** Show the inline Synapse icon on the active editor line. */
	inlineIconEnabled: boolean;
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

export const DEFAULT_SETTINGS: SynapseSettings = {
	authType: 'subscription',
	anthropicApiKey: '',
	claudeLocation: '',
	synapseFolder: 'synapse',
	toolApproval: 'ask',
	inlineModel: '',
	featureAgents: {
		chat: 'General',
		inline: 'General',
		search: 'General',
		telegram: 'General',
		vision: 'Vision',
	},
	autocompleteEnabled: false,
	inlineIconEnabled: false,
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
export const SECURE_FIELDS: ReadonlyArray<keyof SynapseSettings> = ['anthropicApiKey', 'telegramBotToken'];

const SECURE_PREFIX = 'synapse-secure-';

/** Load a secure field from vault-specific local storage. */
export function loadSecureField(app: App, key: string): string {
	const stored = app.loadLocalStorage(SECURE_PREFIX + key);
	return stored != null ? String(stored) : '';
}

/** Save a secure field to vault-specific local storage. */
export function saveSecureField(app: App, key: string, value: string): void {
	app.saveLocalStorage(SECURE_PREFIX + key, value || null);
}

/** Derive the agents subfolder from the base Synapse folder. */
export function getAgentsFolder(settings: SynapseSettings): string {
	return normalizePath(`${settings.synapseFolder}/agents`);
}

/** Derive the skills subfolder from the base Synapse folder. */
export function getSkillsFolder(settings: SynapseSettings): string {
	return normalizePath(`${settings.synapseFolder}/skills`);
}

/** Derive the tools subfolder from the base Synapse folder. */
export function getToolsFolder(settings: SynapseSettings): string {
	return normalizePath(`${settings.synapseFolder}/tools`);
}

/** Derive the prompts subfolder from the base Synapse folder. */
export function getPromptsFolder(settings: SynapseSettings): string {
	return normalizePath(`${settings.synapseFolder}/prompts`);
}

/** Derive the triggers subfolder from the base Synapse folder. */
export function getTriggersFolder(settings: SynapseSettings): string {
	return normalizePath(`${settings.synapseFolder}/triggers`);
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
model: claude-3-7-sonnet
---

# General Assistant Instructions

You are a helpful general assistant for Obsidian. Help the user draft notes, answer questions, structure thoughts, and perform vault tasks.
`;

const SAMPLE_VISION_AGENT = `---
name: Vision
description: Vision-capable agent for analyzing note images, diagrams, and attachments.
model: claude-3-7-sonnet
---

# Vision Assistant Instructions

You are an AI assistant specialized in analyzing visual content, diagrams, images, and attachments embedded in Obsidian notes.
`;

const SAMPLE_ZETTELKASTEN_AGENT = `---
name: Zettelkasten
description: Methodology agent tuned for atomic notes, dense interlinking, and slip-box workflows.
model: claude-3-7-sonnet
---

# Zettelkasten Assistant Instructions

You are a Zettelkasten methodology assistant. Focus on creating atomic, single-concept notes with clear titles, rich context, and bi-directional links ([[note]]).
`;

const SAMPLE_PARA_AGENT = `---
name: PARA
description: Methodology agent tuned for Projects, Areas, Resources, and Archives organization.
model: claude-3-7-sonnet
---

# PARA Assistant Instructions

You are a PARA methodology assistant. Help organize information into Projects (goal-oriented), Areas (responsibilities), Resources (topics of interest), and Archives (inactive items).
`;

const SAMPLE_LYT_AGENT = `---
name: LYT
description: Methodology agent tuned for Linking Your Thinking and Maps of Content (MOCs).
model: claude-3-7-sonnet
---

# LYT Assistant Instructions

You are a Linking Your Thinking (LYT) methodology assistant. Help synthesize notes into Maps of Content (MOCs), facilitating fluid knowledge navigation.
`;

const SAMPLE_PROMPT_CONTENT = `---
agent: General
---
Summarize the key points of the current note into bullet points.
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
		const toolsFolder = normalizePath(`${this.plugin.settings.synapseFolder}/tools`);
		if (!this.app.vault.getAbstractFileByPath(toolsFolder)) {
			const warning = containerEl.createDiv({cls: 'synapse-settings-warning'});
			warning.createEl('p', {
				text: 'Synapse folder is not initialized. Go to the capabilities tab to configure and initialize it.',
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
								await this.plugin.initCopilot();
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
					await this.plugin.initCopilot();
					renderAuthFields();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						if (!this.plugin.copilot) {
							throw new Error('Claude service is not available');
						}
						await this.plugin.copilot.ensureConnected();
						const result = await this.plugin.copilot.chat({
							prompt: 'Reply with exactly: "Connected" — nothing else.',
							maxTurns: 1,
							permissionMode: 'plan',
							tools: [],
						});
						new Notice(result ? `Claude: ${result}` : 'Claude: connected (no response text)');
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
			.setDesc('Custom path to the claude CLI binary. Leave blank to auto-detect.')
			.addText(text => text
				.setPlaceholder('Auto-detect')
				.setValue(this.plugin.settings.claudeLocation)
				.onChange(async (value) => {
					this.plugin.settings.claudeLocation = value.trim();
					await this.plugin.saveSettings();
					await this.plugin.initCopilot();
					await renderCliStatus();
				}));

		const cliStatusEl = claudePanel.createDiv({cls: 'setting-item-description'});
		cliStatusEl.style.marginTop = '8px';
		const renderCliStatus = async () => {
			cliStatusEl.empty();
			if (this.plugin.copilot) {
				try {
					const resolved = await this.plugin.copilot.getVersionInfo();
					const sourceLabels: Record<string, string> = {
						'settings': 'settings override',
						'global-npm': 'global npm install',
						'os-links': 'OS links',
						'sdk-fallback': 'SDK package fallback',
					};
					const sourceStr = sourceLabels[resolved.source] ?? resolved.source;
					let infoStr = `Resolved CLI: ${resolved.path} (from ${sourceStr})`;
					if (resolved.version) {
						infoStr += ` \u2014 v${resolved.version}${resolved.protocolVersion ? `, protocol ${resolved.protocolVersion}` : ''}`;
					}
					cliStatusEl.setText(infoStr);
				} catch {
					cliStatusEl.setText('Resolved CLI: not found');
				}
			}
		};
		void renderCliStatus();


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

			const vaultAgents = await loadAgents(this.app, getAgentsFolder(this.plugin.settings));
			const agentNamesSet = new Set<string>(['General', 'Vision', 'Zettelkasten', 'PARA', 'LYT', ...vaultAgents.map(a => a.name)]);
			const agentOptions: Record<string, string> = {};
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
				const currentAgent = this.plugin.settings.featureAgents?.[feat.id] || (feat.id === 'vision' ? 'Vision' : 'General');
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
							.setPlaceholder('e.g. claude-3-7-sonnet')
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
			.setDesc('Vault folder for agents, skills, tools and triggers.')
			.addText(text => text
				.setPlaceholder('Ex: synapse')
				.setValue(this.plugin.settings.synapseFolder)
				.onChange(async (value) => {
					const sanitized = value.trim().replace(/\.\./g, '');
					if (!sanitized || /[;|&`$(){}]/.test(sanitized)) {
						new Notice('Synapse folder name is invalid.');
						return;
					}
					this.plugin.settings.synapseFolder = sanitized;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const base = normalizePath(this.plugin.settings.synapseFolder);

						for (const sub of ['', '/agents', '/skills', '/skills/ascii-art', '/tools', '/prompts', '/triggers']) {
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

						new Notice('Synapse folder initialized with sample agent, skill, prompt, trigger, and mcp.json.');
					} catch (e) {
						new Notice(`Failed to initialize synapse folder: ${String(e)}`);
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
			.setName('Show inline icon')
			.setDesc('Show the plugin icon in the editor gutter next to the active line.')
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

const MCP_SECRET_PREFIX = 'synapse-mcp-input-';

/** Retrieve the stored value for an MCP input variable. */
export function getMcpInputValue(app: App, plugin: SynapsePlugin, id: string, isPassword: boolean): string | undefined {
	if (isPassword) {
		const stored = app.loadLocalStorage(MCP_SECRET_PREFIX + id);
		return stored != null ? String(stored) : undefined;
	}
	return plugin.settings.mcpInputValues?.[id];
}

/** Store a value for an MCP input variable. */
export async function setMcpInputValue(app: App, plugin: SynapsePlugin, id: string, value: string, isPassword: boolean): Promise<void> {
	if (isPassword) {
		app.saveLocalStorage(MCP_SECRET_PREFIX + id, value);
	} else {
		if (!plugin.settings.mcpInputValues) plugin.settings.mcpInputValues = {};
		plugin.settings.mcpInputValues[id] = value;
		await plugin.saveSettings();
	}
}

/** Delete the stored value for an MCP input variable. */
export async function deleteMcpInputValue(app: App, plugin: SynapsePlugin, id: string, isPassword: boolean): Promise<void> {
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
