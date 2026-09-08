import {MarkdownView, Menu, Notice, TFile, TFolder, setIcon} from 'obsidian';
import type {SynapseView} from '../synapseView';
import {IMAGE_EXTS, isImageAttachment, type SelectionInfo} from '../types';
import {VaultScopeModal} from '../modals/vaultScopeModal';
import {decideWorkingDirAutoUpdate} from './sessionConfig';

declare module '../synapseView' {
	interface SynapseView {
		buildInputArea(parent: HTMLElement): void;
		handleAttachFile(): void;
		handleImagePaste(blob: File): Promise<void>;
		handleFileDrop(e: DragEvent): void;

		renderAttachments(): void;
		renderScopeBar(): void;
		renderActiveNoteBar(): void;
		updateActiveNote(): void;
		startSelectionPolling(): void;
		pollSelection(): void;
		openScopeModal(): void;
		setScope(paths: string[]): void;
		openSearchWithScope(folderPath: string): void;
		setWorkingDir(folderPath: string): void;
		setPromptText(text: string): void;
		addSelectionAttachment(text: string, info: SelectionInfo): void;
		updateStateLine(): void;

		// Slash-command skill popup
		handleInputKeydownForSkillPopup(e: KeyboardEvent): boolean;
		updateSkillPopup(): void;
		renderSkillPopup(): void;
		closeSkillPopup(): void;
		selectSkillPopupMatch(index: number): void;
	}
}

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

export function installInputArea(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SynapseView;

	proto.buildInputArea = function (parent: HTMLElement): void {
		// State line above input (NOTE / AGENT / MODEL)
		this.stateLineEl = parent.createDiv({cls: 'synapse-state-line'});
		this.stateNoteEl = this.stateLineEl.createSpan({cls: 'synapse-state-note', text: 'No note'});
		this.stateLineEl.createSpan({cls: 'synapse-state-sep', text: '/'});
		this.stateAgentEl = this.stateLineEl.createSpan({cls: 'synapse-state-agent', text: 'General'});
		this.stateLineEl.createSpan({cls: 'synapse-state-sep', text: '/'});
		this.stateModelEl = this.stateLineEl.createSpan({cls: 'synapse-state-model', text: 'Default model'});

		const inputArea = parent.createDiv({cls: 'synapse-input-area'});

		// Chips row for attachments, active note & scope
		const chipsContainer = inputArea.createDiv({cls: 'synapse-input-chips'});
		this.attachmentsBar = chipsContainer.createDiv({cls: 'synapse-attachments-bar is-hidden'});
		this.activeNoteBar = chipsContainer.createDiv({cls: 'synapse-active-note-bar is-hidden'});
		this.scopeBar = chipsContainer.createDiv({cls: 'synapse-scope-bar is-hidden'});

		// Textarea
		const inputRow = inputArea.createDiv({cls: 'synapse-input-row'});
		this.inputEl = inputRow.createEl('textarea', {
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
				void this.handleSend();
			}
		};
		window.addEventListener('keydown', keyHandler, true);
		this.register(() => window.removeEventListener('keydown', keyHandler, true));

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

		// Composer actions footer
		const foot = inputArea.createDiv({cls: 'synapse-input-actions synapse-composer-foot'});

		const scopeBtn = foot.createEl('button', {cls: 'synapse-f-btn synapse-f-btn-scope', attr: {title: 'Select vault scope', type: 'button'}});
		const scopeIcon = scopeBtn.createSpan({cls: 'synapse-f-btn-icon'});
		setIcon(scopeIcon, 'folder');
		scopeBtn.createSpan({cls: 'synapse-f-btn-label', text: 'Scope'});
		scopeBtn.addEventListener('click', () => this.openScopeModal());

		const attachBtn = foot.createEl('button', {cls: 'synapse-f-btn synapse-f-btn-attach', attr: {title: 'Attach file', type: 'button'}});
		const attachIcon = attachBtn.createSpan({cls: 'synapse-f-btn-icon'});
		setIcon(attachIcon, 'paperclip');
		attachBtn.createSpan({cls: 'synapse-f-btn-label', text: 'Attach'});
		attachBtn.addEventListener('click', () => this.handleAttachFile());

		foot.createSpan({cls: 'synapse-composer-spacer'});

		this.sendBtn = foot.createEl('button', {
			cls: 'clickable-icon synapse-send-btn',
			attr: {title: 'Send message', type: 'button'},
		});
		setIcon(this.sendBtn, 'arrow-up');
		this.sendBtn.addEventListener('click', () => {
			if (this.isStreaming) {
				void this.handleAbort();
			} else {
				void this.handleSend();
			}
		});

		this.updateStateLine();
	};

	proto.handleAttachFile = function (): void {
		const input = createEl('input');
		input.type = 'file';
		input.multiple = true;
		input.classList.add('synapse-file-input-hidden');
		document.body.appendChild(input);

		input.addEventListener('change', () => {
			if (!input.files) { input.remove(); return; }

			// Resolve absolute OS path: prefer Electron webUtils, fallback to File.path
			let getPath: (f: File) => string;
			try {
				const {webUtils} = window.require('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
				if (webUtils?.getPathForFile) {
					getPath = (f: File) => webUtils.getPathForFile(f);
				} else {
					getPath = (f: File) => (f as unknown as {path: string}).path || '';
				}
			} catch {
				getPath = (f: File) => (f as unknown as {path: string}).path || '';
			}

			for (let i = 0; i < input.files.length; i++) {
				const file = input.files[i];
				if (!file) continue;
				const filePath = getPath(file);
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
	};

	proto.handleImagePaste = async function (blob: File): Promise<void> {
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
	};

	/** Handle files dropped onto the input area from the OS or vault tree. */
	proto.handleFileDrop = function (e: DragEvent): void {
		const dt = e.dataTransfer;
		if (!dt) return;

		// ── Obsidian vault drag (file explorer) ──────────────────
		// Obsidian's file tree uses its internal dragManager rather than
		// standard HTML5 dataTransfer text.  The draggable object has
		// { type: 'file'|'folder'|'files', file?: TAbstractFile, files?: TAbstractFile[] }.
		const dragManager = (this.app as unknown as {dragManager?: {draggable?: {type: string; file?: unknown; files?: unknown[]}}}).dragManager;
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
		// Resolve absolute OS path using Electron webUtils, same as handleAttachFile
		let getPath: (f: File) => string;
		try {
			const {webUtils} = window.require('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
			if (webUtils?.getPathForFile) {
				getPath = (f: File) => webUtils.getPathForFile(f);
			} else {
				getPath = (f: File) => (f as unknown as {path: string}).path || '';
			}
		} catch {
			getPath = (f: File) => (f as unknown as {path: string}).path || '';
		}

		let attached = 0;
		for (let i = 0; i < dt.files.length; i++) {
			const file = dt.files[i];
			if (!file) continue;
			const filePath = getPath(file);
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
	};

	proto.renderAttachments = function (): void {
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
	};

	proto.renderScopeBar = function (): void {
		this.scopeBar.empty();
		if (this.scopePaths.length === 0) {
			this.scopeBar.addClass('is-hidden');
			return;
		}
		this.scopeBar.removeClass('is-hidden');

		const label = this.scopeBar.createSpan({cls: 'synapse-scope-label'});
		setIcon(label, 'folder-tree');
		const isEntireVault = this.scopePaths.length === 1 && this.scopePaths[0] === '/';
		const scopeText = isEntireVault
			? ' Entire vault scope'
			: ` ${this.scopePaths.length} item(s) in scope`;
		label.appendText(scopeText);

		const tooltipItems = this.scopePaths.map(p => p === '/' ? this.app.vault.getName() : p).join('\n');
		label.setAttribute('title', tooltipItems);
		label.addEventListener('click', (e) => {
			const menu = new Menu();
			for (const p of this.scopePaths) {
				const display = p === '/' ? this.app.vault.getName() : p;
				menu.addItem(item => item.setTitle(display).setDisabled(true));
			}
			menu.showAtMouseEvent(e);
		});

		const removeBtn = this.scopeBar.createSpan({cls: 'synapse-scope-remove'});
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', () => {
			this.scopePaths = [];
			this.renderScopeBar();
		});
	};

	proto.updateActiveNote = function (): void {
		const file = this.app.workspace.getActiveFile();
		this.activeNotePath = file ? file.path : null;
		// Clear selection when switching files — pollSelection will pick up the new one
		this.activeSelection = null;
		this.renderActiveNoteBar();
		this.updateStateLine();

		// Update working directory to the parent folder of the active note — deferred
		// while a conversation is in progress so switching notes mid-conversation doesn't
		// force a session rebuild (and its full-transcript cache replay) on every follow-up
		// message (issue #108 / #202).
		if (file && this.plugin.settings.autoUpdateWorkingDirectory) {
			const lastSlash = file.path.lastIndexOf('/');
			const newDir = lastSlash > 0 ? file.path.substring(0, lastSlash) : '';
			const conversationInProgress = this.currentSession !== null && this.messages.length > 0;
			const decision = decideWorkingDirAutoUpdate({
				newDir,
				currentWorkingDir: this.workingDir,
				conversationInProgress,
			});
			if (decision.applyNow) {
				this.workingDir = newDir;
				this.updateCwdButton();
				this.configDirty = true;
			}
			if (decision.pendingDir !== null) {
				this.pendingWorkingDir = decision.pendingDir;
			} else if (decision.clearPending) {
				this.pendingWorkingDir = null;
			}
		}
	};

	/**
	 * Poll the active editor for selection changes and update the active note bar.
	 * Uses a lightweight interval instead of a CM6 extension to avoid coupling.
	 */
	proto.startSelectionPolling = function (): void {
		const POLL_MS = 300;
		const timerId = window.setInterval(() => this.pollSelection(), POLL_MS);
		this.selectionPollTimer = timerId as unknown as ReturnType<typeof setInterval>;
		this.registerInterval(timerId);
	};

	proto.pollSelection = function (): void {
		// Try to get the active MarkdownView. If focus is in our chat view,
		// fall back to iterating workspace leaves to find the most recent editor.
		let mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		let editorIsActive = !!mdView;

		if (!mdView && this.containerEl.contains(document.activeElement)) {
			// Focus is in our chat — find the last MarkdownView leaf to read cursor from
			this.editorHadFocus = false;
			this.app.workspace.iterateAllLeaves(leaf => {
				if (!mdView && leaf.view instanceof MarkdownView) {
					mdView = leaf.view;
				}
			});
			editorIsActive = false;
		}

		if (!mdView) {
			this.editorHadFocus = false;
			if (this.activeSelection) {
				this.activeSelection = null;
				this.renderActiveNoteBar();
				this.updateStateLine();
			}
			this.cursorPosition = null;
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
			this.cursorPosition = {
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
				this.activeSelection = null;
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

		this.activeSelection = {
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
	};

	proto.renderActiveNoteBar = function (): void {
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
				this.activeSelection = null;
				this.renderActiveNoteBar();
				this.updateStateLine();
			});
			tag.setAttribute('title', `Selection in ${sel.filePath} (${sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}-${sel.endLine}`})`);
			return;
		}

		if (!this.activeNotePath) {
			this.activeNoteBar.addClass('is-hidden');
			return;
		}
		// Don't show the active note file chip when a selection attachment for the
		// same file already exists — the selection supersedes the whole-file context.
		if (this.attachments.some(a => a.type === 'selection' && a.path === this.activeNotePath)) {
			this.activeNoteBar.addClass('is-hidden');
			return;
		}
		this.activeNoteBar.removeClass('is-hidden');
		const tag = this.activeNoteBar.createDiv({cls: 'synapse-attachment-tag synapse-active-note-tag'});
		const ic = tag.createSpan({cls: 'synapse-attachment-icon'});
		setIcon(ic, 'file-text');
		const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
		tag.createSpan({text: name, cls: 'synapse-attachment-name'});
		const removeBtn = tag.createSpan({cls: 'synapse-attachment-remove'});
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.activeNotePath = null;
			this.renderActiveNoteBar();
			this.updateStateLine();
		});
		tag.setAttribute('title', `Active note: ${this.activeNotePath}`);
	};

	proto.openScopeModal = function (): void {
		new VaultScopeModal(this.app, this.scopePaths, (paths) => {
			this.scopePaths = paths;
			this.renderScopeBar();
		}).open();
	};

	// ── Public API ───────────────────────────────────────────────

	/** Set the vault scope programmatically and refresh the scope bar. */
	proto.setScope = function (paths: string[]): void {
		this.scopePaths = paths;
		this.renderScopeBar();
	};

	/** Open the search tab with scope set to the given folder. */
	proto.openSearchWithScope = function (folderPath: string): void {
		this.searchWorkingDir = folderPath;
		this.updateSearchCwdButton();
		this.switchTab('search');
		this.searchInputEl.focus();
	};

	/** Set the working directory programmatically. */
	proto.setWorkingDir = function (folderPath: string): void {
		this.workingDir = folderPath;
		this.updateCwdButton();
		this.configDirty = true;
	};

	/** Set the prompt text programmatically and focus the input. */
	proto.setPromptText = function (text: string): void {
		this.inputEl.value = text;
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
	};

	/** Add a selection attachment from the editor context menu / synapse button. */
	proto.addSelectionAttachment = function (text: string, info: SelectionInfo): void {
		// Resolve filePath: prefer info.filePath, fall back to current active file
		const filePath = info.filePath ?? this.app.workspace.getActiveFile()?.path;
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
	};

	// ── State line (Editorial restyle #208) ───────────────────────

	proto.updateStateLine = function (): void {
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
		let agentText = 'General';
		if (this.selectedAgent) {
			const found = this.agents.find(a => a.name === this.selectedAgent);
			agentText = found?.name || this.selectedAgent;
		}
		if (this.stateAgentEl) {
			this.stateAgentEl.setText(agentText);
			this.stateAgentEl.setAttribute('title', `Agent: ${agentText}`);
		}

		// Model
		let modelText = 'Default model';
		if (this.selectedModel) {
			const found = this.models.find(m => m.id === this.selectedModel);
			modelText = found?.name || this.selectedModel;
		}
		if (this.stateModelEl) {
			this.stateModelEl.setText(modelText);
			this.stateModelEl.setAttribute('title', `Model: ${modelText}`);
		}
	};

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
	proto.updateSkillPopup = function (): void {
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
		const matches = this.getEffectiveSkills().filter(s =>
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
	};

	/** (Re)render the popup dropdown from `skillPopupMatches`, creating it lazily. */
	proto.renderSkillPopup = function (): void {
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
	};

	/** Close and remove the popup, resetting its filter state. */
	proto.closeSkillPopup = function (): void {
		this.skillPopupMatches = [];
		this.skillPopupSelectedIndex = 0;
		this.skillPopupSlashIndex = -1;
		if (this.skillPopupEl) {
			this.skillPopupEl.remove();
			this.skillPopupEl = null;
		}
	};

	/** Complete the textarea's `/`-token with the chosen skill's name (no send, no stripping). */
	proto.selectSkillPopupMatch = function (index: number): void {
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
	};

	/**
	 * Intercept navigation/selection keys while the popup is open, ahead of the
	 * normal Enter-to-send handling. Returns true when the key was consumed by the
	 * popup (caller should not process it further).
	 */
	proto.handleInputKeydownForSkillPopup = function (e: KeyboardEvent): boolean {
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
	};
}
