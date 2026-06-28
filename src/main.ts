import {MarkdownView, Notice, Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, SidekickSettings, SidekickSettingTab, SECURE_FIELDS, loadSecureField, saveSecureField} from "./settings";
import {CopilotService} from "./copilot";
import {fetchProviderModels} from "./providerModels";
import {SidekickView, SIDEKICK_VIEW_TYPE} from "./sidekickView";
import {registerEditorMenu, registerFileMenu, openSidekickView, showEditNoteModal, showStructureModal, runSelectionAction} from './editor/editorMenu';
import {buildGhostTextExtension, triggerComplete} from './editor/ghostText';
import {TelegramBotService} from './bots';
import {TASKS} from './tasks';
import {EditModal} from './modals/editModal';
import type {EditorView} from '@codemirror/view';

export default class SidekickPlugin extends Plugin {
	settings!: SidekickSettings;
	copilot: CopilotService | null = null;
	telegramBot: TelegramBotService | null = null;

	async onload() {
		await this.loadSettings();
		this.applyInlineIconClass();
		this.addSettingTab(new SidekickSettingTab(this.app, this));

		// Register the Sidekick chat view
		this.registerView(SIDEKICK_VIEW_TYPE, (leaf) => new SidekickView(leaf, this));

		// Ribbon icon to open view
		this.addRibbonIcon('brain', 'Open sidekick', () => void this.activateView());

		// Command to open view
		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			hotkeys: [{modifiers: ['Mod', 'Shift'], key: 'k'}],
			callback: () => void this.activateView(),
		});

		// Helper to get CM6 EditorView from active MarkdownView
		const getEditorView = (): EditorView | null => {
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!mdView) return null;
			return (mdView as unknown as {editor?: {cm?: EditorView}}).editor?.cm ?? null;
		};

		// Command: Chat with sidekick (send selection or open chat)
		this.addCommand({
			id: 'chat-with-sidekick',
			name: 'Chat with sidekick',
			hotkeys: [{modifiers: ['Mod', 'Shift'], key: 'l'}],
			callback: () => {
				const cmView = getEditorView();
				if (cmView) {
					const sel = cmView.state.selection.main;
					if (!sel.empty) {
						const text = cmView.state.sliceDoc(sel.from, sel.to);
						const startLine = cmView.state.doc.lineAt(sel.from);
						const endLine = cmView.state.doc.lineAt(sel.to);
						const activeFile = this.app.workspace.getActiveFile();
						openSidekickView(this, text, {
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
				openSidekickView(this);
			},
		});

		// Command: Edit the note
		this.addCommand({
			id: 'edit-note',
			name: 'Edit the note',
			hotkeys: [{modifiers: ['Mod', 'Shift'], key: 'e'}],
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (cmView) showEditNoteModal(this, cmView);
			},
		});

		// Command: Structure and refine
		this.addCommand({
			id: 'structure-and-refine',
			name: 'Structure and refine',
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (cmView) showStructureModal(this, cmView);
			},
		});

		// Command: Edit selection (advanced editing modal)
		this.addCommand({
			id: 'edit-selection',
			name: 'Edit selection',
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (!cmView) return;
				const sel = cmView.state.selection.main;
				if (sel.empty) {
					new Notice('Sidekick: select some text first.');
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
					const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
					if (!cmView) return;
					const sel = cmView.state.selection.main;
					if (sel.empty) {
						new Notice('Sidekick: select some text first.');
						return;
					}
					const selectedText = cmView.state.sliceDoc(sel.from, sel.to);
					void runSelectionAction(this, cmView, selectedText, task);
				},
			});
		}

		// Command: Toggle autocomplete
		this.addCommand({
			id: 'toggle-autocomplete',
			name: 'Toggle autocomplete',
			callback: async () => {
				this.settings.autocompleteEnabled = !this.settings.autocompleteEnabled;
				await this.saveData(this.settings);
				new Notice(`Sidekick: autocomplete ${this.settings.autocompleteEnabled ? 'enabled' : 'disabled'}.`);
			},
		});

		// Command: Trigger autocomplete
		this.addCommand({
			id: 'trigger-autocomplete',
			name: 'Trigger autocomplete',
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (cmView) cmView.dispatch({effects: triggerComplete.of(null)});
			},
		});

		// Editor context menu (Sidekick submenu for selected text)
		registerEditorMenu(this);

		// Vault tree context menu (Sidekick submenu for note files)
		registerFileMenu(this);

		// Ghost-text autocomplete (inline suggestions)
		this.registerEditorExtension(buildGhostTextExtension(this));

		try {
			await this.initCopilot();
			// Eagerly connect so CLI-not-found errors surface at startup
			// (triggers getStatus → version log as a side-effect).
			if (this.copilot) {
				await this.copilot.ensureConnected();
			}
		} catch (e) {
			console.error('Sidekick: failed to initialize Copilot service', e);
			const msg = e instanceof Error ? e.message : String(e);
			// Try to detect "missing CLI" specifically (spawn ENOENT / not found), not any CLI error.
			const detail = msg.match(/\(([^)]*)\)\./)?.[1] ?? msg;
			if (/enoent|spawn|not found/i.test(detail)) {
				const isWin = typeof process !== 'undefined' && process.platform === 'win32';
				const installHint = isWin
					? 'No Copilot CLI found. Install with `winget install GitHub.CopilotCLI` or `npm install -g @github/copilot`, then restart the plugin.'
					: 'No Copilot CLI found. Install with `npm install -g @github/copilot`, then restart the plugin.';
				new Notice(installHint, 30000);
			}
		}
	}

	async initCopilot(): Promise<void> {
		if (this.copilot) {
			try {
				await this.copilot.stop();
			} catch {
				// ignore stop errors
			}
			this.copilot = null;
		}
		const s = this.settings;

		// BYOK model listing: when a non-GitHub provider is configured, fetch
		// models from the provider endpoint so client.listModels() returns them.
		const onListModels = this.buildOnListModels();

		const onVersionInfo = (status: {version: string; protocolVersion: number}) => {
			console.info('Sidekick: Copilot CLI v%s (protocol %d)', status.version, status.protocolVersion);
		};

		// Build BYOK provider config for inline/editor operations
		const providerConfig = this.buildProviderConfig();

		// Ollama-specific connection error notice
		const ollamaErrorMsg = 'Could not reach Ollama at localhost:11434. ' +
			'Is it running? Start it with `ollama serve`.';
		const onConnectionError = s.providerPreset === 'ollama'
			? () => { new Notice(ollamaErrorMsg, 8000); }
			: undefined;

		const requestTimeout = s.providerRequestTimeout > 0 ? s.providerRequestTimeout * 1000 : undefined;

		const providerOpts = {
			...(onListModels ? {onListModels} : {}),
			onVersionInfo,
			...(onConnectionError ? {onConnectionError} : {}),
			...(providerConfig ? {provider: providerConfig} : {}),
			// foundry-local requires non-streaming mode
			...(s.providerPreset === 'foundry-local' ? {streaming: false} : {}),
			...(requestTimeout ? {requestTimeout} : {}),
		};

		if (s.copilotType === 'remote') {
			const url = s.cliUrl.trim();
			this.copilot = new CopilotService({
				cliUrl: url || undefined,
				githubToken: s.githubToken || undefined,
				...providerOpts,
			});
		} else {
			const loc = s.copilotLocation.trim();
			this.copilot = new CopilotService({
				cliPath: loc.length > 0 ? loc : undefined,
				useLoggedInUser: s.useLoggedInUser,
				githubToken: !s.useLoggedInUser && s.githubToken ? s.githubToken : undefined,
				...providerOpts,
			});
		}
	}

	/**
	 * Build the BYOK ProviderConfig from current settings, or undefined for
	 * the GitHub preset. Used by both CopilotService (for inline operations)
	 * and buildSessionConfig (for the chat panel).
	 */
	buildProviderConfig(): import('./copilot').ProviderConfig | undefined {
		const s = this.settings;
		if (s.providerPreset === 'github' || !s.providerBaseUrl) return undefined;

		const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
			openai: 'openai',
			azure: 'azure',
			anthropic: 'anthropic',
			ollama: 'openai',
			'foundry-local': 'openai',
			'other-openai': 'openai',
		};

		return {
			type: typeMap[s.providerPreset] ?? 'openai',
			baseUrl: s.providerBaseUrl,
			...(s.providerApiKey ? {apiKey: s.providerApiKey} : {}),
			...(s.providerBearerToken ? {bearerToken: s.providerBearerToken} : {}),
			wireApi: s.providerWireApi,
			...(s.providerMaxPromptTokens > 0 ? {maxPromptTokens: s.providerMaxPromptTokens} : {}),
		};
	}

	/**
	 * Build an onListModels callback for BYOK providers that fetches models
	 * from the provider's endpoint. Returns undefined for GitHub preset.
	 */
	private buildOnListModels(): (() => Promise<import('./copilot').ModelInfo[]>) | undefined {
		const s = this.settings;
		if (s.providerPreset === 'github' || !s.providerBaseUrl) return undefined;

		const params = {
			preset: s.providerPreset,
			baseUrl: s.providerBaseUrl,
			apiKey: s.providerApiKey,
			bearerToken: s.providerBearerToken,
		};

		return async (): Promise<import('./copilot').ModelInfo[]> => {
			const result = await fetchProviderModels(params);
			return result.ok ? result.models : [];
		};
	}

	onunload() {
		document.body.removeClass('sidekick-no-inline-icon');
		if (this.copilot) {
			void this.copilot.stop();
		}
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

	notifySidebarModelsChanged(models: import('./copilot').ModelInfo[]): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof SidekickView) {
				view.refreshProviderModels(models);
			}
		}
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
		if (existing.length > 0 && existing[0]) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: SIDEKICK_VIEW_TYPE, active: true});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		const raw = await this.loadData() as Partial<SidekickSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

		// Migrate any plaintext secrets from data.json to local storage, then strip
		let needsSave = false;
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

	applyInlineIconClass() {
		document.body.toggleClass('sidekick-no-inline-icon', !this.settings.inlineIconEnabled);
	}

	async saveSettings() {
		// Clone settings and strip secure fields before writing to data.json
		const dataToSave = {...this.settings};
		for (const key of SECURE_FIELDS) {
			(dataToSave as Record<string, unknown>)[key] = '';
		}
		await this.saveData(dataToSave);
		this.applyInlineIconClass();
	}
}
