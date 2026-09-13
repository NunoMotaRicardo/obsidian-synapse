import {MarkdownView, Notice, Plugin, addIcon} from 'obsidian';
import {DEFAULT_SETTINGS, SynapseSettings, SynapseSettingTab, SECURE_FIELDS, loadSecureField, saveSecureField} from "./settings";
import {AgentService, type ModelInfo} from "./agentService";
import {releasePluginSetTimeoutShim} from './sdkShims';
import {fetchEndpointModels} from "./providerModels";
import {SynapseView, SYNAPSE_VIEW_TYPE} from './synapseView';
import {registerEditorMenu, registerFileMenu, openSynapseView, showEditNoteModal, showStructureModal, runSelectionAction} from './editor/editorMenu';
import {TelegramBotService} from './bots';
import {TASKS} from './tasks';
import {EditModal} from './modals/editModal';
import {ensureImproveSynapseSkill} from './configWriter';
import {debugTrace} from './debug';
import {getCmView} from './utils';
import type {EditorView} from '@codemirror/view';

export const SYNAPSE_ICON_ID = 'synapse-icon';
export const SYNAPSE_ICON_SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g transform="translate(50,50)" fill="currentColor"><circle r="9"/><g transform="rotate(-90)"><rect x="10.4" y="-2.2" width="17" height="4.4" rx="2.2"/><circle cx="34" cy="0" r="5.6"/></g><g transform="rotate(30)"><rect x="10.4" y="-2.2" width="17" height="4.4" rx="2.2"/><circle cx="34" cy="0" r="5.6"/></g><g transform="rotate(150)"><rect x="10.4" y="-2.2" width="17" height="4.4" rx="2.2"/><circle cx="34" cy="0" r="5.6"/></g></g></svg>';

export default class SynapsePlugin extends Plugin {
	settings!: SynapseSettings;
	agentService: AgentService | null = null;
	telegramBot: TelegramBotService | null = null;

	async onload() {
		// Register custom Synapse icon in Obsidian's global icon registry
		addIcon(SYNAPSE_ICON_ID, SYNAPSE_ICON_SVG);

		// ── Migrate localStorage keys from old prefix ──
		this.migrateLocalStorageKeys();

		await this.loadSettings();

		// Seed improve-synapse skill on first run if missing
		try {
			await ensureImproveSynapseSkill(this.app);
		} catch (e) {
			console.error('Synapse: failed to seed improve-synapse skill', e);
		}

		this.addSettingTab(new SynapseSettingTab(this.app, this));

		// Register the Synapse chat view
		this.registerView(SYNAPSE_VIEW_TYPE, (leaf) => new SynapseView(leaf, this));

		// Ribbon icon to open view
		this.addRibbonIcon(SYNAPSE_ICON_ID, 'Open Synapse', () => void this.activateView());

		// Command to open view
		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			callback: () => void this.activateView(),
		});

		// Helper to get CM6 EditorView from active MarkdownView
		const getEditorView = (): EditorView | null => {
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!mdView) return null;
			return getCmView(mdView) ?? null;
		};

		// Command: Chat with Synapse (send selection or open chat)
		this.addCommand({
			id: 'chat-with-synapse',
			name: 'Chat with selection',
			callback: () => {
				const cmView = getEditorView();
				if (cmView) {
					const sel = cmView.state.selection.main;
					if (!sel.empty) {
						const text = cmView.state.sliceDoc(sel.from, sel.to);
						const startLine = cmView.state.doc.lineAt(sel.from);
						const endLine = cmView.state.doc.lineAt(sel.to);
						const activeFile = this.app.workspace.getActiveFile();
						openSynapseView(this, text, {
							filePath: activeFile?.path,
							fileName: activeFile?.name ?? 'unknown',
							startLine: startLine.number,
							startChar: sel.from - startLine.from,
							endLine: endLine.number,
							endChar: sel.to - endLine.from,
						});
						return;
					}
				}
				openSynapseView(this);
			},
		});

		// Command: Edit the note
		this.addCommand({
			id: 'edit-note',
			name: 'Edit the note',
			editorCallback: (_editor, view) => {
				const cmView = getCmView(view);
				if (cmView) showEditNoteModal(this, cmView);
			},
		});

		// Command: Structure and refine
		this.addCommand({
			id: 'structure-and-refine',
			name: 'Structure and refine',
			editorCallback: (_editor, view) => {
				const cmView = getCmView(view);
				if (cmView) showStructureModal(this, cmView);
			},
		});

		// Command: Edit selection (advanced editing modal)
		this.addCommand({
			id: 'edit-selection',
			name: 'Edit selection',
			editorCallback: (_editor, view) => {
				const cmView = getCmView(view);
				if (!cmView) return;
				const sel = cmView.state.selection.main;
				if (sel.empty) {
					new Notice('Synapse: select some text first.');
					return;
				}
				const selectedText = cmView.state.sliceDoc(sel.from, sel.to);
				new EditModal(this, selectedText, (result: string) => {
					const currentSel = cmView.state.selection.main;
					cmView.dispatch({changes: {from: currentSel.from, to: currentSel.to, insert: result}});
				}).open();
			},
		});

		// Text-transform commands for each task
		for (const task of TASKS) {
			this.addCommand({
				id: `text-action-${task.label.toLowerCase().replace(/\s+/g, '-')}`,
				name: task.label,
				editorCallback: (_editor, view) => {
					const cmView = getCmView(view);
					if (!cmView) return;
					const sel = cmView.state.selection.main;
					if (sel.empty) {
						new Notice('Synapse: select some text first.');
						return;
					}
					const selectedText = cmView.state.sliceDoc(sel.from, sel.to);
					void runSelectionAction(this, cmView, selectedText, task);
				},
			});
		}

		// Editor context menu (Synapse submenu for selected text)
		registerEditorMenu(this);

		// Vault tree context menu (Synapse submenu for note files)
		registerFileMenu(this);

		try {
			await this.initAgentService();
			// Eagerly connect so auth errors surface at startup.
			if (this.agentService) {
				await this.agentService.ensureConnected();
				this.agentService.fetchModels()
					.then(models => this.notifySidebarModelsChanged(models))
					.catch(() => {});
			}
		} catch (e) {
			console.error('Synapse: failed to initialize agent service', e);
			const msg = e instanceof Error ? e.message : String(e);
			if (/enoent|spawn|not found/i.test(msg)) {
				const isWin = process.platform === 'win32';
				const installCmd = isWin
					? 'winget install Anthropic.ClaudeCode or npm install -g @anthropic-ai/claude-code'
					: 'npm install -g @anthropic-ai/claude-code';
				new Notice(
					`No Claude CLI found. Install with "${installCmd}", then restart the plugin.`,
					30000,
				);
			}
		}
	}

	async initAgentService(): Promise<void> {
		if (this.agentService) {
			try {
				await this.agentService.stop();
			} catch {
				// ignore stop errors
			}
			this.agentService = null;
		}
		const s = this.settings;

		this.agentService = new AgentService({
			auth: {
				type: s.authType,
				apiKey: s.authType === 'apiKey' ? s.anthropicApiKey : undefined,
			},
			...(s.localAgentEndpointUrl.trim() ? {
				localAgentEndpoint: {
					baseUrl: s.localAgentEndpointUrl.trim(),
					apiKey: s.localAgentEndpointApiKey,
				},
			} : {}),
			claudeLocation: s.claudeLocation,
			onVersionInfo: (info) => {
				debugTrace(`Synapse: Claude CLI v${info.version} at ${info.path}`);
			},
		});
		// Model discovery (#220): when a local agent endpoint is configured, fetch its
		// `/v1/models` catalogue (issue #122) and offer the models it lists alongside the
		// Claude ones. Fire-and-forget — a catalogue failure must not block service init;
		// the endpoint's Test button (issue #223) is where a broken endpoint is diagnosed.
		if (s.localAgentEndpointUrl.trim()) {
			void fetchEndpointModels({
				baseUrl: s.localAgentEndpointUrl,
				apiKey: s.localAgentEndpointApiKey,
			}).then(res => {
				if (res.ok && res.models.length > 0) {
					this.setProviderModels(res.models);
				}
			}).catch(() => {});
		}
		this.notifySidebarModelsChanged(this.agentService.getModels());
	}

	/**
	 * Migrate Obsidian vault-scoped localStorage keys from old 'claude-brain-secure-'
	 * and 'claude-brain-mcp-input-' prefixes to 'synapse-secure-' and 'synapse-mcp-input-'.
	 */
	private migrateLocalStorageKeys(): void {
		const migrations: [string, string][] = [
			['claude-brain-secure-', 'synapse-secure-'],
			['claude-brain-mcp-input-', 'synapse-mcp-input-'],
		];
		// Obsidian's app.loadLocalStorage/saveLocalStorage adds a vault-specific
		// prefix internally, so we use those APIs for correct namespacing.
		for (const [oldPrefix, newPrefix] of migrations) {
			// Known key suffixes for secure fields
			const suffixes = oldPrefix.includes('secure')
				? ['anthropicApiKey', 'telegramBotToken']
				: [];

			if (oldPrefix.includes('mcp-input')) {
				for (let i = 0; i < window.localStorage.length; i++) {
					const fullKey = window.localStorage.key(i);
					if (fullKey && fullKey.includes(':' + oldPrefix)) {
						const suffix = fullKey.substring(fullKey.indexOf(':' + oldPrefix) + 1 + oldPrefix.length);
						if (suffix) {
							suffixes.push(suffix);
						}
					}
				}
			}

			for (const suffix of suffixes) {
				// loadLocalStorage() is typed `any | null` in obsidian.d.ts; narrow to unknown.
				const oldValue: unknown = this.app.loadLocalStorage(oldPrefix + suffix);
				if (oldValue != null) {
					const existing: unknown = this.app.loadLocalStorage(newPrefix + suffix);
					if (existing == null) {
						this.app.saveLocalStorage(newPrefix + suffix, oldValue);
					}
					this.app.saveLocalStorage(oldPrefix + suffix, null);
				}
			}
		}
	}

	onunload() {
		if (this.agentService) {
			void this.agentService.stop();
		}
		releasePluginSetTimeoutShim();
		if (this.telegramBot) {
			void this.telegramBot.disconnect();
		}
	}

	async connectTelegram(): Promise<void> {
		const token = this.settings.telegramBotToken;
		if (!token) throw new Error('No bot token configured.');
		if (!this.telegramBot) {
			this.telegramBot = new TelegramBotService(this);
		}
		await this.telegramBot.connect(token);
	}

	disconnectTelegram(): void {
		if (this.telegramBot) {
			this.telegramBot.disconnect();
		}
	}

	setProviderModels(models: ModelInfo[]): void {
		if (this.agentService) {
			this.agentService.setCustomModels(models);
			this.notifySidebarModelsChanged(this.agentService.getModels());
		}
	}

	notifySidebarModelsChanged(models: ModelInfo[]): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SYNAPSE_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof SynapseView) {
				view.refreshProviderModels(models);
			}
		}
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SYNAPSE_VIEW_TYPE);
		if (existing.length > 0 && existing[0]) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: SYNAPSE_VIEW_TYPE, active: true});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		const raw = await this.loadData() as (Partial<SynapseSettings> & Record<string, unknown>) | null;
		let needsSave = false;

		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		this.settings.featureAgents = Object.assign({}, DEFAULT_SETTINGS.featureAgents, raw?.featureAgents);

		// The OpenAI-compatible provider matrix and its local ReAct loop were removed (#220),
		// taking `providerPreset`/`providerBaseUrl`/`providerApiKey`/`providerBearerToken`
		// with them. No migration shim — per planner decision 6 the four stale keys are
		// stripped from the merged settings here (otherwise `Object.assign`'s spread keeps
		// them as untyped extras and `saveSettings()` would re-persist them forever) — and a
		// vault whose raw data.json carried a non-empty `providerBaseUrl` gets a one-time
		// courtesy Notice pointing at the replacement, same convention as #117's
		// removed-preset notice. The Notice is one-time *because* of the strip: once saved
		// below (`needsSave`), data.json no longer carries the keys, so `raw` never sees
		// them again on a later load. Stale localStorage values for the two removed secrets
		// are harmless (nothing reads that prefix anymore) and are left alone.
		const legacyProviderKeys = ['providerPreset', 'providerBaseUrl', 'providerApiKey', 'providerBearerToken'] as const;
		let carriedProviderBaseUrl = false;
		for (const key of legacyProviderKeys) {
			if (typeof raw?.[key] === 'string' && raw[key].trim() && key === 'providerBaseUrl') {
				carriedProviderBaseUrl = true;
			}
			if (key in this.settings) {
				delete (this.settings as unknown as Record<string, unknown>)[key];
				needsSave = true;
			}
		}
		if (carriedProviderBaseUrl) {
			new Notice(
				'Synapse: the local & custom provider presets were removed. Local models now run through the ' +
				'local agent endpoint — configure it under Settings → Synapse → Claude → Local agent endpoint.',
				0
			);
		}

		// Migrate any plaintext secrets from data.json to local storage, then strip
		for (const key of SECURE_FIELDS) {
			const plaintext = raw?.[key];
			if (plaintext && typeof plaintext === 'string') {
				// Migrate: write to local storage if not already present
				const existing = loadSecureField(this.app, key);
				if (!existing) {
					saveSecureField(this.app, key, plaintext);
				}
				needsSave = true;
			}
			// Load from secure storage into runtime settings
			(this.settings as unknown as Record<string, unknown>)[key] = loadSecureField(this.app, key);
		}

		// Strip plaintext secrets from data.json if they were present
		if (needsSave) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		// Clone settings and strip secure fields before writing to data.json
		const dataToSave = {...this.settings};
		for (const key of SECURE_FIELDS) {
			(dataToSave as Record<string, unknown>)[key] = '';
		}
		await this.saveData(dataToSave);
	}
}
