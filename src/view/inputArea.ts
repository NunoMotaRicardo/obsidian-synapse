import {MarkdownView, Menu, Notice, TFile, TFolder, setIcon} from 'obsidian';
import {IMAGE_EXTS, isImageAttachment, type ChatAttachment, type SelectionInfo, type SkillInfo} from '../types';
import {VaultScopeModal} from '../modals/vaultScopeModal';
import {decideWorkingDirAutoUpdate} from './sessionConfig';
import {resolveFilePath} from '../utils';
import type {ViewContext} from './types';

/**
 * Skill-name characters accepted while typing a `/name` filter (no spaces).
 *
 * `:` is included (issue #163) because the popup inserts the CLI's namespaced id for
 * plugin-provided commands (`/_synapse:improve-synapse`). Without it the scan-back from the
 * caret stopped at the colon, so the popup could not re-parse text it had itself inserted.
 * This does not make `and/or: x` trigger the popup — opening still requires the `/` to be at
 * the start of the input or preceded by whitespace.
 */
const SKILL_NAME_CHAR = /[A-Za-z0-9_:-]/;

/**
 * Input-area controller (composition refactor — formerly prototype injection into
 * `SynapseView`, `.docs/research/2026-09-11-view-composition-refactor.md`). Owns the
 * composer DOM it builds (state line, chips bars, textarea, slash-command skill popup)
 * and the editor selection-polling loop, and reaches the shared view state —
 * `attachments`, `activeNotePath`, `activeSelection`, `cursorPosition`, `scopePaths`,
 * `workingDir`/`pendingWorkingDir`, `enabledSkills`, `selectedAgent`/`selectedModel` —
 * through its `ViewContext`.
 *
 * `inputEl` and `cwdBtnEl` stay view-owned DOM fields that this controller assigns in
 * `build()`: `SynapseView.handleSend()` reads and clears the textarea directly, and
 * configToolbar reaches the cwd button through its own `cwdBtnEl` accessor.
 */
export class InputAreaController {
	// ── Composer DOM refs (moved from SynapseView) ───────────────
	private stateLineEl!: HTMLElement;
	private stateNoteEl!: HTMLElement;
	private stateAgentEl!: HTMLElement;
	private stateModelEl!: HTMLElement;
	private attachmentsBar!: HTMLElement;
	private activeNoteBar!: HTMLElement;
	private scopeBar!: HTMLElement;
	private scopeBtn?: HTMLButtonElement;
	private attachBtn?: HTMLButtonElement;

	// ── Slash-command skill popup state (moved from SynapseView) ─
	private skillPopupEl: HTMLElement | null = null;
	/** Filtered skill list currently shown in the popup, in display order. */
	private skillPopupMatches: SkillInfo[] = [];
	/** Index into `skillPopupMatches` of the highlighted row. */
	private skillPopupSelectedIndex = 0;
	/** Start offset (in `inputEl.value`) of the `/` that triggered the popup. */
	private skillPopupSlashIndex = -1;

	// ── Selection-polling state (moved from SynapseView) ─────────
	private selectionPollTimer: ReturnType<typeof setInterval> | null = null;
	private editorHadFocus = false;

	constructor(private view: ViewContext) {}

	// ── View-owned element/state accessors ───────────────────────
	// Accessors (not copied fields) so the historical `this.<name>` spellings in the
	// methods below keep compiling against state that still lives on `SynapseView`;
	// assignments to these go through as `this.view.view.<name> = ...`.
	private get inputEl(): HTMLTextAreaElement {
		return this.view.view.inputEl;
	}

	private get attachments(): ChatAttachment[] {
		return this.view.view.attachments;
	}

	private get activeNotePath(): string | null {
		return this.view.view.activeNotePath;
	}

	private get activeSelection(): {filePath: string; fileName: string; text: string; startLine: number; startChar: number; endLine: number; endChar: number} | null {
		return this.view.view.activeSelection;
	}

	private get scopePaths(): string[] {
		return this.view.view.scopePaths;
	}

	private get selectedAgent(): string {
		return this.view.view.selectedAgent;
	}

	private get selectedModel(): string {
		return this.view.view.selectedModel;
	}

	private get enabledSkills(): Set<string> {
		return this.view.view.enabledSkills;
	}

	/** Build the composer (state line, chips bars, textarea) into `parent`. */
	build(parent: HTMLElement): void {
		// State line above input (DIR / SCOPE / ATTACH / NOTE / AGENT / MODEL)
		this.stateLineEl = parent.createDiv({cls: 'synapse-state-line'});

		// Working directory button (moved to top row) — `cwdBtnEl` stays a view-owned DOM
		// ref: configToolbar reaches it through ViewContext (see its `cwdBtnEl` accessor).
		this.view.view.cwdBtnEl = this.stateLineEl.createEl('button', {
			cls: 'synapse-toolbar-btn synapse-cwd-btn',
			attr: {type: 'button'},
		});
		this.view.view.cwdBtnEl.addEventListener('click', () => this.view.view.configToolbar.openCwdPicker());
		this.view.view.configToolbar.updateCwdButton();

		// Scope button (icon only)
		this.scopeBtn = this.stateLineEl.createEl('button', {
			cls: 'synapse-toolbar-btn synapse-f-btn synapse-f-btn-scope',
			attr: {title: 'Select vault scope', 'aria-label': 'Scope', type: 'button'},
		});
		const scopeIcon = this.scopeBtn.createSpan({cls: 'synapse-f-btn-icon'});
		setIcon(scopeIcon, 'folder');
		this.scopeBtn.toggleClass('is-active', this.scopePaths.length > 0);
		this.scopeBtn.addEventListener('click', () => this.openScopeModal());

		// Attach button (icon only)
		this.attachBtn = this.stateLineEl.createEl('button', {
			cls: 'synapse-toolbar-btn synapse-f-btn synapse-f-btn-attach',
			attr: {title: 'Attach file', 'aria-label': 'Attach', type: 'button'},
		});
		const attachIcon = this.attachBtn.createSpan({cls: 'synapse-f-btn-icon'});
		setIcon(attachIcon, 'paperclip');
		this.attachBtn.toggleClass('is-active', this.attachments.length > 0);
		this.attachBtn.addEventListener('click', () => this.handleAttachFile());

		this.stateNoteEl = this.stateLineEl.createSpan({cls: 'synapse-state-note', text: 'No note'});
		this.stateLineEl.createSpan({cls: 'synapse-state-sep', text: '/'});
		this.stateAgentEl = this.stateLineEl.createSpan({cls: 'synapse-state-agent', text: 'Auto'});
		this.stateLineEl.createSpan({cls: 'synapse-state-sep', text: '/'});
		this.stateModelEl = this.stateLineEl.createSpan({cls: 'synapse-state-model', text: 'Default model'});

		const inputArea = parent.createDiv({cls: 'synapse-input-area'});

		// Chips row for attachments, active note & scope
		const chipsContainer = inputArea.createDiv({cls: 'synapse-input-chips'});
		this.attachmentsBar = chipsContainer.createDiv({cls: 'synapse-attachments-bar is-hidden'});
		this.activeNoteBar = chipsContainer.createDiv({cls: 'synapse-active-note-bar is-hidden'});
		this.scopeBar = chipsContainer.createDiv({cls: 'synapse-scope-bar is-hidden'});

		// Textarea — `inputEl` stays a view-owned field (synapseView.ts's handleSend()
		// reads and clears it), so build() assigns it onto the view.
		const inputRow = inputArea.createDiv({cls: 'synapse-input-row'});
		this.view.view.inputEl = inputRow.createEl('textarea', {
			cls: 'synapse-input',
			attr: {placeholder: 'Ask or paste something to work on...', rows: '1'},
		});

		// Auto-resize + slash-command skill popup filtering
		this.inputEl.addEventListener('input', () => {
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
			this.updateSkillPopup();
		});

		// Caret can move without an `input` event (arrow keys, Home/End, mouse click) —
		// refresh the popup so it closes once the caret leaves the `/name` token.
		this.inputEl.addEventListener('mouseup', () => this.updateSkillPopup());
		this.inputEl.addEventListener('keyup', (e: KeyboardEvent) => {
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
				this.updateSkillPopup();
			}
		});

		// Reposition/close the popup if focus leaves the textarea (e.g. clicking elsewhere).
		this.inputEl.addEventListener('blur', () => {
			// Defer so a click on a popup row (which also blurs the textarea) can still register.
			window.setTimeout(() => this.closeSkillPopup(), 150);
		});

		// Ctrl+Enter or Enter (without Shift) to send
		// Register on window in capture phase — earliest interception before Obsidian's hotkey system
		const keyHandler = (e: KeyboardEvent) => {
			if (document.activeElement !== this.inputEl) return;

			// Slash-command popup gets first crack at navigation keys while open.
			if (this.handleInputKeydownForSkillPopup(e)) return;

			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				void this.view.view.handleSend();
			}
		};
		window.addEventListener('keydown', keyHandler, true);
		this.view.view.register(() => window.removeEventListener('keydown', keyHandler, true));

		// Paste handler for images
		this.inputEl.addEventListener('paste', (e: ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item && item.type.startsWith('image/')) {
					e.preventDefault();
					const blob = item.getAsFile();
					if (blob) void this.handleImagePaste(blob);
					return;
				}
			}
		});

		// Drag-and-drop external files onto the input area
		let dragCounter = 0;
		inputArea.addEventListener('dragenter', (e: DragEvent) => {
			e.preventDefault();
			dragCounter++;
			inputArea.addClass('synapse-drag-over');
		});
		inputArea.addEventListener('dragover', (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		});
		inputArea.addEventListener('dragleave', () => {
			dragCounter--;
			if (dragCounter <= 0) {
				dragCounter = 0;
				inputArea.removeClass('synapse-drag-over');
			}
		});
		inputArea.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			dragCounter = 0;
			inputArea.removeClass('synapse-drag-over');
			this.handleFileDrop(e);
		});
		this.updateStateLine();
	}

	private handleAttachFile(): void {
		const input = createEl('input');
		input.type = 'file';
		input.multiple = true;
		input.classList.add('synapse-file-input-hidden');
		document.body.appendChild(input);

		input.addEventListener('change', () => {
			if (!input.files) { input.remove(); return; }

			for (let i = 0; i < input.files.length; i++) {
				const file = input.files[i];
				if (!file) continue;
				const filePath = resolveFilePath(file);
				if (!filePath) {
					continue;
				}
				this.attachments.push({type: 'file', name: file.name, path: filePath, absolutePath: true});
			}
			this.renderAttachments();
			input.remove();
		});

		input.addEventListener('cancel', () => input.remove());
		input.click();
	}

	private async handleImagePaste(blob: File): Promise<void> {
		try {
			const buffer = await blob.arrayBuffer();
			const bytes = new Uint8Array(buffer);
			let binary = '';
			for (let i = 0; i < bytes.length; i++) {
				binary += String.fromCharCode(bytes[i]!);
			}
			const base64 = btoa(binary);
			const mimeType = blob.type || 'image/png';
			const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
			const name = `paste-${Date.now()}.${ext}`;

			this.attachments.push({type: 'blob', name, data: base64, mimeType});
			this.renderAttachments();
			new Notice('Image attached.');
		} catch (e) {
			new Notice(`Failed to attach image: ${String(e)}`);
		}
	}

	/** Handle files dropped onto the input area from the OS or vault tree. */
	private handleFileDrop(e: DragEvent): void {
		const dt = e.dataTransfer;
		if (!dt) return;

		// ── Obsidian vault drag (file explorer) ──────────────────
		// Obsidian's file tree uses its internal dragManager rather than
		// standard HTML5 dataTransfer text.  The draggable object has
		// { type: 'file'|'folder'|'files', file?: TAbstractFile, files?: TAbstractFile[] }.
		const dragManager = (this.view.app as unknown as {dragManager?: {draggable?: {type: string; file?: unknown; files?: unknown[]}}}).dragManager;
		const draggable = dragManager?.draggable as {type: string; file?: TFile | TFolder; files?: (TFile | TFolder)[]} | undefined;

		if (draggable) {
			const items: (TFile | TFolder)[] = [];
			if ((draggable.type === 'file' || draggable.type === 'folder') && draggable.file) {
				items.push(draggable.file);
			} else if (draggable.type === 'files' && draggable.files) {
				items.push(...draggable.files);
			}

			if (items.length > 0) {
				for (const item of items) {
					if (item instanceof TFolder) {
						this.setScope([item.path]);
						this.setWorkingDir(item.path);
						new Notice(`Scope and working directory set to "${item.path}".`);
					} else if (item instanceof TFile) {
						this.attachments.push({type: 'file', name: item.name, path: item.path});
						this.renderAttachments();
						new Notice(`"${item.name}" attached.`);
					}
				}
				return;
			}
		}

		// ── Plain text drag (e.g. selected text from editor or browser) ──
		if (dt.files.length === 0) {
			const text = dt.getData('text/plain');
			if (text) {
				this.inputEl.value = text;
				this.inputEl.setCssProps({'--input-height': 'auto'});
				this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
				this.inputEl.focus();
				return;
			}
		}

		// ── External OS file drag ────────────────────────────────
		// Resolve absolute OS path using the shared helper, same as handleAttachFile
		let attached = 0;
		for (let i = 0; i < dt.files.length; i++) {
			const file = dt.files[i];
			if (!file) continue;
			const filePath = resolveFilePath(file);
			if (!filePath) continue;

			const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
			if (IMAGE_EXTS.has(ext)) {
				// Save image to vault attachment folder, same as paste
				void this.handleImagePaste(file);
			} else {
				this.attachments.push({type: 'file', name: file.name, path: filePath, absolutePath: true});
			}
			attached++;
		}

		if (attached > 0) {
			this.renderAttachments();
			new Notice(`${attached} file${attached > 1 ? 's' : ''} attached.`);
		}
	}

	renderAttachments(): void {
		this.attachBtn?.toggleClass('is-active', this.attachments.length > 0);
		this.attachmentsBar.empty();
		if (this.attachments.length === 0) {
			this.attachmentsBar.addClass('is-hidden');
			return;
		}
		this.attachmentsBar.removeClass('is-hidden');

		for (let i = 0; i < this.attachments.length; i++) {
			const att = this.attachments[i];
			if (!att) continue;
			const tag = this.attachmentsBar.createDiv({cls: 'synapse-attachment-tag'});
			const typeIcon = isImageAttachment(att) ? 'image' : att.type === 'clipboard' ? 'clipboard' : att.type === 'selection' ? 'text-cursor-input' : 'file-text';
			const ic = tag.createSpan({cls: 'synapse-attachment-icon'});
			setIcon(ic, typeIcon);
			tag.createSpan({text: att.name, cls: 'synapse-attachment-name'});
			const removeBtn = tag.createSpan({cls: 'synapse-attachment-remove'});
			setIcon(removeBtn, 'x');
			const idx = i;
			removeBtn.addEventListener('click', () => {
				this.attachments.splice(idx, 1);
				this.renderAttachments();
				this.renderActiveNoteBar();
			});
		}
	}

	renderScopeBar(): void {
		this.scopeBtn?.toggleClass('is-active', this.scopePaths.length > 0);
		this.scopeBar.empty();
		if (this.scopePaths.length === 0) {
			this.scopeBar.addClass('is-hidden');
			this.scopeBar.removeClass('synapse-attachment-tag');
			this.scopeBar.removeClass('synapse-scope-tag');
			return;
		}
		this.scopeBar.removeClass('is-hidden');
		this.scopeBar.addClass('synapse-attachment-tag');
		this.scopeBar.addClass('synapse-scope-tag');

		const label = this.scopeBar.createSpan({cls: 'synapse-scope-label'});
		const ic = label.createSpan({cls: 'synapse-attachment-icon'});
		setIcon(ic, 'folder-tree');
		const isEntireVault = this.scopePaths.length === 1 && this.scopePaths[0] === '/';
		const scopeText = isEntireVault
			? 'Entire vault scope'
			: `${this.scopePaths.length} item(s) in scope`;
		label.createSpan({text: scopeText, cls: 'synapse-scope-name'});

		const tooltipItems = this.scopePaths.map(p => p === '/' ? this.view.app.vault.getName() : p).join('\n');
		label.setAttribute('title', tooltipItems);
		label.addEventListener('click', (e) => {
			const menu = new Menu();
			for (const p of this.scopePaths) {
				const display = p === '/' ? this.view.app.vault.getName() : p;
				menu.addItem(item => item.setTitle(display).setDisabled(true));
			}
			menu.showAtMouseEvent(e);
		});

		const removeBtn = this.scopeBar.createSpan({cls: 'synapse-attachment-remove synapse-scope-remove'});
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', () => {
			this.view.view.scopePaths = [];
			this.renderScopeBar();
		});
	}

	updateActiveNote(): void {
		const file = this.view.app.workspace.getActiveFile();
		this.view.view.activeNotePath = file ? file.path : null;
		// Clear selection when switching files — pollSelection will pick up the new one
		this.view.view.activeSelection = null;
		this.renderActiveNoteBar();
		this.updateStateLine();

		// Update working directory to the parent folder of the active note — deferred
		// while a conversation is in progress so switching notes mid-conversation doesn't
		// force a session rebuild (and its full-transcript cache replay) on every follow-up
		// message (issue #108 / #202).
		if (file && this.view.plugin.settings.autoUpdateWorkingDirectory) {
			const lastSlash = file.path.lastIndexOf('/');
			const newDir = lastSlash > 0 ? file.path.substring(0, lastSlash) : '';
			const conversationInProgress = this.view.view.currentSession !== null && this.view.view.messages.length > 0;
			const decision = decideWorkingDirAutoUpdate({
				newDir,
				currentWorkingDir: this.view.view.workingDir,
				conversationInProgress,
			});
			if (decision.applyNow) {
				this.view.view.workingDir = newDir;
				this.view.view.configToolbar.updateCwdButton();
				this.view.configDirty = true;
			}
			if (decision.pendingDir !== null) {
				this.view.view.pendingWorkingDir = decision.pendingDir;
			} else if (decision.clearPending) {
				this.view.view.pendingWorkingDir = null;
			}
		}
	}

	/**
	 * Poll the active editor for selection changes and update the active note bar.
	 * Uses a lightweight interval instead of a CM6 extension to avoid coupling.
	 */
	startSelectionPolling(): void {
		const POLL_MS = 300;
		const timerId = window.setInterval(() => this.pollSelection(), POLL_MS);
		this.selectionPollTimer = timerId as unknown as ReturnType<typeof setInterval>;
		this.view.view.registerInterval(timerId);
	}

	private pollSelection(): void {
		// Try to get the active MarkdownView. If focus is in our chat view,
		// fall back to iterating workspace leaves to find the most recent editor.
		let mdView = this.view.app.workspace.getActiveViewOfType(MarkdownView);
		let editorIsActive = !!mdView;

		if (!mdView && this.view.view.containerEl.contains(document.activeElement)) {
			// Focus is in our chat — find the last MarkdownView leaf to read cursor from
			this.editorHadFocus = false;
			this.view.app.workspace.iterateAllLeaves(leaf => {
				if (!mdView && leaf.view instanceof MarkdownView) {
					mdView = leaf.view;
				}
			});
			editorIsActive = false;
		}

		if (!mdView) {
			this.editorHadFocus = false;
			if (this.activeSelection) {
				this.view.view.activeSelection = null;
				this.renderActiveNoteBar();
				this.updateStateLine();
			}
			this.view.view.cursorPosition = null;
			return;
		}

		const editorFocused = editorIsActive && mdView.containerEl.contains(document.activeElement);
		const editor = mdView.editor;
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		const hasSelection = from.line !== to.line || from.ch !== to.ch;

		// Always update cursor position from the editor
		const cursorFile = mdView.file;
		if (cursorFile) {
			this.view.view.cursorPosition = {
				filePath: cursorFile.path,
				fileName: cursorFile.name,
				line: from.line + 1,
				ch: from.ch,
			};
		}

		if (!hasSelection) {
			// Editor just regained focus (wasn't focused last tick) — the selection
			// collapsed because of the focus change, not a deliberate user action.
			// Keep the tracked selection intact.
			if (editorFocused && !this.editorHadFocus) {
				this.editorHadFocus = true;
				return;
			}
			// Editor was already focused — user deliberately deselected.
			// Or editor is not focused (cursor read from background leaf) — keep selection if tracked.
			if (!editorIsActive) {
				// Reading from background editor — don't clear selection
				return;
			}
			this.editorHadFocus = editorFocused;
			if (this.activeSelection) {
				this.view.view.activeSelection = null;
				this.renderActiveNoteBar();
				this.updateStateLine();
			}
			return;
		}
		// Active selection present — cursor position is the selection start (already set above)
		this.editorHadFocus = editorFocused;

		const file = mdView.file;
		if (!file) return;

		const text = editor.getRange(from, to);
		const prev = this.activeSelection;
		// Only re-render if the selection actually changed
		if (prev && prev.filePath === file.path && prev.startLine === from.line + 1 && prev.endLine === to.line + 1 && prev.startChar === from.ch && prev.endChar === to.ch) {
			return;
		}

		this.view.view.activeSelection = {
			filePath: file.path,
			fileName: file.name,
			text,
			startLine: from.line + 1,
			startChar: from.ch,
			endLine: to.line + 1,
			endChar: to.ch,
		};
		this.renderActiveNoteBar();
		this.updateStateLine();
	}

	private renderActiveNoteBar(): void {
		this.activeNoteBar.empty();

		// If there's a live editor selection, show it instead of the active note
		if (this.activeSelection) {
			this.activeNoteBar.removeClass('is-hidden');
			const tag = this.activeNoteBar.createDiv({cls: 'synapse-attachment-tag synapse-active-note-tag'});
			const ic = tag.createSpan({cls: 'synapse-attachment-icon'});
			setIcon(ic, 'text-cursor-input');
			const sel = this.activeSelection;
			const displayName = sel.startLine === sel.endLine
				? `${sel.fileName}:${sel.startLine}`
				: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
			tag.createSpan({text: displayName, cls: 'synapse-attachment-name'});
			const removeBtn = tag.createSpan({cls: 'synapse-attachment-remove'});
			setIcon(removeBtn, 'x');
			removeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.view.view.activeSelection = null;
				this.renderActiveNoteBar();
				this.updateStateLine();
			});
			tag.setAttribute('title', `Selection in ${sel.filePath} (${sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}-${sel.endLine}`})`);
			return;
		}

		// The active note is already displayed in the top state line (this.stateNoteEl),
		// so it does not need to appear repeated in the second row.
		this.activeNoteBar.addClass('is-hidden');
	}

	private openScopeModal(): void {
		new VaultScopeModal(this.view.app, this.scopePaths, (paths) => {
			this.view.view.scopePaths = paths;
			this.renderScopeBar();
		}).open();
	}

	// ── Public API ───────────────────────────────────────────────

	/** Set the vault scope programmatically and refresh the scope bar. */
	setScope(paths: string[]): void {
		this.view.view.scopePaths = paths;
		this.renderScopeBar();
	}

	/** Open the search tab with scope set to the given folder. */
	openSearchWithScope(folderPath: string): void {
		this.view.view.search.openSearchWithScope(folderPath);
	}

	/** Set the working directory programmatically. */
	setWorkingDir(folderPath: string): void {
		this.view.view.workingDir = folderPath;
		this.view.view.configToolbar.updateCwdButton();
		this.view.configDirty = true;
	}

	/** Set the prompt text programmatically and focus the input. */
	setPromptText(text: string): void {
		this.inputEl.value = text;
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
	}

	/** Add a selection attachment from the editor context menu / synapse button. */
	addSelectionAttachment(text: string, info: SelectionInfo): void {
		// Resolve filePath: prefer info.filePath, fall back to current active file
		const filePath = info.filePath ?? this.view.app.workspace.getActiveFile()?.path;
		if (!filePath) return; // can't create selection attachment without a file
		const displayName = info.startLine === info.endLine
			? `${info.fileName}:${info.startLine}`
			: `${info.fileName}:${info.startLine}-${info.endLine}`;
		this.attachments.push({
			type: 'selection',
			name: displayName,
			path: filePath,
			content: text,
			selection: {
				startLine: info.startLine,
				startChar: info.startChar,
				endLine: info.endLine,
				endChar: info.endChar,
			},
		});
		this.renderAttachments();
		this.renderActiveNoteBar();
		this.updateStateLine();
	}

	// ── State line (Editorial restyle #208) ───────────────────────

	updateStateLine(): void {
		if (!this.stateLineEl) return;

		// Note
		let noteText = 'No note';
		if (this.activeSelection) {
			const sel = this.activeSelection;
			noteText = sel.startLine === sel.endLine
				? `${sel.fileName}:${sel.startLine}`
				: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
		} else if (this.activeNotePath) {
			noteText = this.activeNotePath.split('/').pop() || this.activeNotePath;
		}
		if (this.stateNoteEl) {
			this.stateNoteEl.setText(noteText);
			this.stateNoteEl.setAttribute('title', this.activeSelection ? `Selection: ${noteText}` : (this.activeNotePath ? `Active note: ${this.activeNotePath}` : 'No active note'));
		}

		// Agent
		let agentText = 'Auto';
		if (this.selectedAgent) {
			const found = this.view.view.agents.find(a => a.name === this.selectedAgent);
			agentText = found?.name || this.selectedAgent;
		}
		if (this.stateAgentEl) {
			this.stateAgentEl.setText(agentText);
			this.stateAgentEl.setAttribute('title', `Agent: ${agentText}`);
		}

		// Model
		let modelText = 'Default model';
		if (this.selectedModel) {
			const found = this.view.view.models.find(m => m.id === this.selectedModel);
			modelText = found?.name || this.selectedModel;
		}
		if (this.stateModelEl) {
			this.stateModelEl.setText(modelText);
			this.stateModelEl.setAttribute('title', `Model: ${modelText}`);
		}
	}

	// ── Slash-command skill popup ───────────────────────────────

	/**
	 * Recompute the skill popup's open/closed state and filtered matches from the
	 * current caret position in `inputEl`. Called on every `input` event.
	 *
	 * Trigger rule: a `/` is a trigger candidate only when preceded by start-of-message
	 * or whitespace (so `and/or`, `3/4`, `path/to/x` never open the popup). The popup
	 * stays open while the caret is inside a contiguous run of skill-name characters
	 * immediately after that `/`; a space or any other boundary closes it.
	 */
	private updateSkillPopup(): void {
		const value = this.inputEl.value;
		const caret = this.inputEl.selectionStart ?? value.length;

		// Scan left from the caret for a `/` starting a valid trigger, stopping at
		// the first character that isn't a valid skill-name character.
		let i = caret - 1;
		while (i >= 0 && SKILL_NAME_CHAR.test(value[i]!)) i--;
		if (i < 0 || value[i] !== '/') {
			this.closeSkillPopup();
			return;
		}
		const precedingChar = i > 0 ? value[i - 1] : undefined;
		const isValidTrigger = i === 0 || precedingChar === undefined || /\s/.test(precedingChar);
		if (!isValidTrigger) {
			this.closeSkillPopup();
			return;
		}

		const query = value.slice(i + 1, caret).toLowerCase();
		// Only suggest skills actually loaded into this session — an agent's `skills:`
		// restriction narrows `enabledSkills` below the full discovered `this.skills` set.
		// Live CLI supportedCommands() (issue #130) when the session has captured one,
		// else the `_synapse/skills/` directory scan — see `getEffectiveSkills()`.
		// Match on the skill's own name first — that is what the user typed when creating it
		// — but also accept the CLI's namespaced id, so the text the popup itself inserts still
		// re-filters to the same entry (issue #163).
		const matches = this.view.view.configToolbar.getEffectiveSkills().filter(s =>
			this.enabledSkills.has(s.name)
			&& (s.name.toLowerCase().startsWith(query) || (s.qualifiedName?.toLowerCase().startsWith(query) ?? false))
		);
		if (matches.length === 0) {
			this.closeSkillPopup();
			return;
		}

		this.skillPopupSlashIndex = i;
		this.skillPopupMatches = matches;
		this.skillPopupSelectedIndex = Math.min(this.skillPopupSelectedIndex, matches.length - 1);
		if (this.skillPopupSelectedIndex < 0) this.skillPopupSelectedIndex = 0;
		this.renderSkillPopup();
	}

	/** (Re)render the popup dropdown from `skillPopupMatches`, creating it lazily. */
	private renderSkillPopup(): void {
		if (!this.skillPopupEl) {
			const inputArea = this.inputEl.closest('.synapse-input-area');
			if (!inputArea) return;
			this.skillPopupEl = inputArea.createDiv({cls: 'synapse-skill-popup'});
		}
		const popup = this.skillPopupEl;
		popup.empty();
		popup.removeClass('is-hidden');

		for (let idx = 0; idx < this.skillPopupMatches.length; idx++) {
			const skill = this.skillPopupMatches[idx]!;
			const row = popup.createDiv({cls: 'synapse-skill-popup-item'});
			row.toggleClass('is-selected', idx === this.skillPopupSelectedIndex);
			row.createSpan({text: `/${skill.name}`, cls: 'synapse-skill-popup-name'});
			if (skill.description) {
				row.createSpan({text: skill.description, cls: 'synapse-skill-popup-desc'});
			}
			// mousedown (not click) fires before the textarea's blur handler closes the popup.
			row.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this.selectSkillPopupMatch(idx);
			});
		}
	}

	/** Close and remove the popup, resetting its filter state. */
	private closeSkillPopup(): void {
		this.skillPopupMatches = [];
		this.skillPopupSelectedIndex = 0;
		this.skillPopupSlashIndex = -1;
		if (this.skillPopupEl) {
			this.skillPopupEl.remove();
			this.skillPopupEl = null;
		}
	}

	/** Complete the textarea's `/`-token with the chosen skill's name (no send, no stripping). */
	private selectSkillPopupMatch(index: number): void {
		const skill = this.skillPopupMatches[index];
		if (!skill || this.skillPopupSlashIndex < 0) return;
		const value = this.inputEl.value;
		const caret = this.inputEl.selectionStart ?? value.length;
		const before = value.slice(0, this.skillPopupSlashIndex);
		// Replace through the end of the contiguous skill-name run, not just to the
		// caret — the caret may sit mid-token (e.g. after ArrowLeft), and stopping at
		// it would leave the token's trailing characters behind as stray text.
		let end = caret;
		while (end < value.length && SKILL_NAME_CHAR.test(value[end]!)) end++;
		const after = value.slice(end);
		// Insert the CLI's namespaced id when there is one: it is the form the CLI advertises
		// and therefore certainly resolves. `name` is only ever the display/filter form (#163).
		const inserted = `/${skill.qualifiedName ?? skill.name} `;
		this.inputEl.value = before + inserted + after;
		const newCaret = before.length + inserted.length;
		this.inputEl.setSelectionRange(newCaret, newCaret);
		this.inputEl.focus();
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.closeSkillPopup();
	}

	/**
	 * Intercept navigation/selection keys while the popup is open, ahead of the
	 * normal Enter-to-send handling. Returns true when the key was consumed by the
	 * popup (caller should not process it further).
	 */
	private handleInputKeydownForSkillPopup(e: KeyboardEvent): boolean {
		if (this.skillPopupMatches.length === 0) return false;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			this.skillPopupSelectedIndex = (this.skillPopupSelectedIndex + 1) % this.skillPopupMatches.length;
			this.renderSkillPopup();
			return true;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			this.skillPopupSelectedIndex = (this.skillPopupSelectedIndex - 1 + this.skillPopupMatches.length) % this.skillPopupMatches.length;
			this.renderSkillPopup();
			return true;
		}
		if (e.key === 'Tab' || e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
			this.selectSkillPopupMatch(this.skillPopupSelectedIndex);
			return true;
		}
		if (e.key === 'Escape' || e.key === ' ') {
			this.closeSkillPopup();
			// Space is not consumed — it should still be typed into the textarea.
			return e.key === 'Escape';
		}
		return false;
	}

	/** Clear the selection-polling interval (view onClose) — see `startSelectionPolling()`. */
	destroy(): void {
		if (this.selectionPollTimer) { window.clearInterval(this.selectionPollTimer); this.selectionPollTimer = null; }
	}
}
