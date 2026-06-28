import {MarkdownView, Notice, Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, ClaudeBrainSettings, ClaudeBrainSettingTab, SECURE_FIELDS, loadSecureField, saveSecureField} from "./settings";
import {AgentService} from "./copilot";
import {ClaudeBrainView, CLAUDE_BRAIN_VIEW_TYPE} from "./claudeBrainView";
import {registerEditorMenu, registerFileMenu, openClaudeBrainView, showEditNoteModal, showStructureModal, runSelectionAction} from './editor/editorMenu';
import {buildGhostTextExtension, triggerComplete} from './editor/ghostText';
import {TelegramBotService} from './bots';
import {TASKS} from './tasks';
import {EditModal} from './modals/editModal';
import type {EditorView} from '@codemirror/view';

export default class ClaudeBrainPlugin extends Plugin {
	settings!: ClaudeBrainSettings;
	copilot: AgentService | null = null;
	telegramBot: TelegramBotService | null = null;

	async onload() {
		await this.loadSettings();
		this.applyInlineIconClass();
		this.addSettingTab(new ClaudeBrainSettingTab(this.app, this));

		// Register the Claude Brain chat view
		this.registerView(CLAUDE_BRAIN_VIEW_TYPE, (leaf) => new ClaudeBrainView(leaf, this));

		// Ribbon icon to open view
		this.addRibbonIcon('brain', 'Open Claude Brain', () => void this.activateView());

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

		// Command: Chat with Claude Brain (send selection or open chat)
		this.addCommand({
			id: 'chat-with-claude-brain',
			name: 'Chat with Claude Brain',
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
						openClaudeBrainView(this, text, {
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
				openClaudeBrainView(this);
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
					new Notice('Claude Brain: select some text first.');
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
						new Notice('Claude Brain: select some text first.');
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
				new Notice(`Claude Brain: autocomplete ${this.settings.autocompleteEnabled ? 'enabled' : 'disabled'}.`);
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

		// Editor context menu (Claude Brain submenu for selected text)
		registerEditorMenu(this);

		// Vault tree context menu (Claude Brain submenu for note files)
		registerFileMenu(this);

		// Ghost-text autocomplete (inline suggestions)
		this.registerEditorExtension(buildGhostTextExtension(this));

		try {
			await this.initCopilot();
			// Eagerly connect so auth errors surface at startup.
			if (this.copilot) {
				await this.copilot.ensureConnected();
			}
		} catch (e) {
			console.error('Claude Brain: failed to initialize agent service', e);
			const msg = e instanceof Error ? e.message : String(e);
			if (/enoent|spawn|not found/i.test(msg)) {
				new Notice(
					'No Claude CLI found. Install with "npm install -g @anthropic-ai/claude-code", then restart the plugin.',
					30000,
				);
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

		this.copilot = new AgentService({
			auth: {
				type: s.authType,
				apiKey: s.authType === 'apiKey' ? s.anthropicApiKey : undefined,
			},
		});
	}

	onunload() {
		document.body.removeClass('claude-brain-no-inline-icon');
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
		for (const leaf of this.app.workspace.getLeavesOfType(CLAUDE_BRAIN_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof ClaudeBrainView) {
				view.refreshProviderModels(models);
			}
		}
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CLAUDE_BRAIN_VIEW_TYPE);
		if (existing.length > 0 && existing[0]) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: CLAUDE_BRAIN_VIEW_TYPE, active: true});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		const raw = await this.loadData() as Partial<ClaudeBrainSettings> | null;
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
		document.body.toggleClass('claude-brain-no-inline-icon', !this.settings.inlineIconEnabled);
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
