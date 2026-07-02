import {
	Component,
	MarkdownView,
	Notice,
	TFile,
	TFolder,
	normalizePath,
	setIcon,
} from 'obsidian';
import type {SynapseView} from '../synapseView';
import {SYNAPSE_ICON_ID} from '../main';
import {isImageAttachment, type ChatMessage, type ChatAttachment} from '../types';
import {renderMarkdownSafe} from './utils';
import type {TodoItem} from '../agentService';

const MAX_DEBUG_DISPLAY_LEN = 5000;

declare module '../synapseView' {
	interface SynapseView {
		addUserMessage(content: string, attachments: ChatAttachment[], scopePaths: string[]): void;
		addInfoMessage(text: string): void;
		renderMessageBubble(msg: ChatMessage): Promise<void>;
		renderUserMessageContent(content: string, body: HTMLElement): void;
		addAssistantPlaceholder(): void;
		showProcessingIndicator(): void;
		removeProcessingIndicator(): void;
		appendDelta(delta: string): void;
		updateStreamingRenderIncremental(): void;
		doFullStreamingRender(): Promise<void>;
		updateStreamingRender(): Promise<void>;
		finalizeStreamingMessage(): void;
		renderMessageMetadata(): void;
		addToolCallBlock(toolCallId: string, toolName: string, args?: unknown): void;
		completeToolCallBlock(toolCallId: string, success: boolean, result?: {content?: string; detailedContent?: string}, error?: {message: string}): void;
		addCompactionStartBlock(data: {conversationTokens?: number; systemTokens?: number; toolDefinitionsTokens?: number}): void;
		addCompactionCompleteBlock(data: {success: boolean; tokensRemoved?: number; messagesRemoved?: number; summaryContent?: string; preCompactionTokens?: number; postCompactionTokens?: number; error?: string}): void;
		renderWelcome(): void;
		updateSendButton(): void;
		renderReasoningBlock(reasoning: string, parent: HTMLElement): Promise<void>;
		startReasoningBlock(): void;
		appendReasoningDelta(delta: string): void;
		syncReasoningContent(content: string): void;
		doFullReasoningRender(): Promise<void>;
		finalizeReasoning(): void;
		clearReasoningState(): void;
		renderTaskPanel(todos: TodoItem[]): void;
		updateTaskPanelElapsed(): void;
		clearTaskPanelState(): void;
	}
}

export function installChatRenderer(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SynapseView;

	proto.addUserMessage = function (content: string, attachments: ChatAttachment[], scopePaths: string[]): void {
		// Combine file/clipboard attachments with scope path entries for display
		const allAttachments = [...attachments];
		for (const sp of scopePaths) {
			const displayName = sp === '/' ? this.app.vault.getName() : sp;
			const abstract = sp === '/'
				? this.app.vault.getRoot()
				: this.app.vault.getAbstractFileByPath(sp);
			const type = abstract instanceof TFolder ? 'directory' as const : 'file' as const;
			allAttachments.push({type, name: displayName, path: sp});
		}

		const msg: ChatMessage = {
			id: `u-${Date.now()}`,
			role: 'user',
			content,
			timestamp: Date.now(),
			attachments: allAttachments.length > 0 ? allAttachments : undefined,
		};
		this.messages.push(msg);
		void this.renderMessageBubble(msg);
		this.scrollToBottom();
	};

	proto.addInfoMessage = function (text: string): void {
		const msg: ChatMessage = {id: `i-${Date.now()}`, role: 'info', content: text, timestamp: Date.now()};
		this.messages.push(msg);
		void this.renderMessageBubble(msg);
		this.scrollToBottom();
	};

	proto.renderMessageBubble = function (msg: ChatMessage): Promise<void> {
		if (msg.role === 'info') {
			const el = this.chatContainer.createDiv({cls: 'synapse-msg synapse-msg-info'});
			el.createSpan({text: msg.content});
			return Promise.resolve();
		}

		const wrapper = this.chatContainer.createDiv({
			cls: `synapse-msg synapse-msg-${msg.role}`,
		});

		const bodyWrapper = wrapper.createDiv({cls: 'synapse-msg-body-wrapper'});

		// Attachments
		if (msg.attachments && msg.attachments.length > 0) {
			const attRow = bodyWrapper.createDiv({cls: 'synapse-msg-attachments'});
			for (const att of msg.attachments) {
				const chip = attRow.createSpan({cls: 'synapse-msg-att-chip synapse-att-clickable'});
				const ic = chip.createSpan();
				const icon = att.type === 'directory' ? 'folder' : isImageAttachment(att) ? 'image' : att.type === 'clipboard' ? 'clipboard' : att.type === 'selection' ? 'text-cursor-input' : 'file-text';
				setIcon(ic, icon);
				chip.appendText(` ${att.name}`);

				// Click to open
				if (att.type === 'clipboard') {
					// Clipboard: copy content back to clipboard
					if (att.content) {
						chip.setAttribute('title', 'Copy to clipboard');
						chip.addEventListener('click', () => {
							void navigator.clipboard.writeText(att.content!);
							new Notice('Copied to clipboard.');
						});
					}
				} else if (att.absolutePath && att.path) {
					// External OS file: open with default OS application
					chip.setAttribute('title', 'Open with os default application');
					chip.addEventListener('click', () => {
						try {
							const filePath = att.path!;
							// Reject paths with traversal sequences
							if (/\.\.[/\\]/.test(filePath)) {
								new Notice('Cannot open file: path contains directory traversal.');
								return;
							}
							const {shell} = globalThis.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							void shell.openPath(filePath);
						} catch (e) {
							new Notice(`Failed to open file: ${String(e)}`);
						}
					});
				} else if (att.type === 'image' && att.path) {
					// Pasted image in vault: open with OS image viewer
					chip.setAttribute('title', 'Open with os image viewer');
					chip.addEventListener('click', () => {
						try {
							const vaultPath = normalizePath(att.path!);
							// Reject paths that escape the vault via traversal
							if (vaultPath.startsWith('..') || vaultPath.includes('/../')) {
								new Notice('Cannot open image: path escapes the vault.');
								return;
							}
							const {shell} = globalThis.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							const absPath = this.getVaultBasePath() + '/' + vaultPath;
							void shell.openPath(absPath);
						} catch (e) {
							new Notice(`Failed to open image: ${String(e)}`);
						}
					});
				} else if (att.type === 'directory' && att.path) {
					// Vault folder: reveal in file explorer
					chip.setAttribute('title', 'Reveal in file explorer');
					chip.addEventListener('click', () => {
						const folder = att.path === '/'
							? this.app.vault.getRoot()
							: this.app.vault.getAbstractFileByPath(att.path!);
						if (folder) {
							// Reveal the folder in Obsidian's file explorer
							const fileExplorer = this.app.workspace.getLeavesOfType('file-explorer')[0];
							if (fileExplorer) {
								void this.app.workspace.revealLeaf(fileExplorer);
								(fileExplorer.view as unknown as {revealInFolder?: (f: unknown) => void}).revealInFolder?.(folder);
							}
						}
					});
				} else if (att.type === 'selection' && att.path) {
					// Selection: open file at the selected line
					const selRange = att.selection;
					const preview = att.content && att.content.length > 80 ? att.content.slice(0, 80) + '…' : att.content || '';
					const rangeLabel = selRange
						? selRange.startLine === selRange.endLine
							? `line ${selRange.startLine}`
							: `lines ${selRange.startLine}-${selRange.endLine}`
						: '';
					chip.setAttribute('title', `Open ${att.path}${rangeLabel ? ` (${rangeLabel})` : ''}${preview ? `:\n${preview}` : ''}`);
					chip.addEventListener('click', () => {
						const file = this.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							const leaf = this.app.workspace.getLeaf(false);
							void leaf.openFile(file).then(() => {
								if (selRange) {
									const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
									if (mdView) {
										mdView.editor.setCursor({line: selRange.startLine - 1, ch: selRange.startChar});
										mdView.editor.setSelection(
											{line: selRange.startLine - 1, ch: selRange.startChar},
											{line: selRange.endLine - 1, ch: selRange.endChar},
										);
									}
								}
							});
						}
					});
				} else if (att.type === 'file' && att.path) {
					// Vault file: open in Obsidian
					chip.setAttribute('title', 'Open in Obsidian');
					chip.addEventListener('click', () => {
						const file = this.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							void this.app.workspace.getLeaf(false).openFile(file);
						}
					});
				}
			}
		}

		if (msg.role === 'assistant' && msg.reasoning) {
			void this.renderReasoningBlock(msg.reasoning, bodyWrapper);
		}

		const body = bodyWrapper.createDiv({cls: 'synapse-msg-body'});

		if (msg.role === 'assistant') {
			return renderMarkdownSafe(this.app, msg.content, body, this.streamingComponent ?? this);
		} else {
			this.renderUserMessageContent(msg.content, body);
			// Copy button for user messages
			const copyBtn = wrapper.createEl('button', {
				cls: 'synapse-msg-copy',
				attr: {title: 'Copy to clipboard'},
			});
			setIcon(copyBtn, 'copy');
			copyBtn.addEventListener('click', () => {
				void navigator.clipboard.writeText(msg.content);
				setIcon(copyBtn, 'check');
				setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
			});
		}
		return Promise.resolve();
	};

	proto.renderReasoningBlock = function (reasoning: string, parent: HTMLElement): Promise<void> {
		const details = parent.createEl('details', {cls: 'synapse-reasoning'});
		const summary = details.createEl('summary', {cls: 'synapse-reasoning-summary'});
		const iconEl = summary.createSpan({cls: 'synapse-reasoning-icon'});
		setIcon(iconEl, 'lightbulb');
		summary.appendText('Reasoning');
		const body = details.createDiv({cls: 'synapse-reasoning-body'});
		return renderMarkdownSafe(this.app, reasoning, body, this.streamingComponent ?? this);
	};

	/**
	 * Render user message content.
	 */
	proto.renderUserMessageContent = function (content: string, body: HTMLElement): void {
		body.createEl('p', {text: content});
	};

	proto.addAssistantPlaceholder = function (): void {
		const wrapper = this.chatContainer.createDiv({cls: 'synapse-msg synapse-msg-assistant'});

		const bodyWrapper = wrapper.createDiv({cls: 'synapse-msg-body-wrapper'});

		// Container for collapsible tool call blocks
		this.toolCallsContainer = bodyWrapper.createDiv({cls: 'synapse-tool-calls'});

		const body = bodyWrapper.createDiv({cls: 'synapse-msg-body'});
		const thinking = body.createDiv({cls: 'synapse-thinking'});
		thinking.createSpan({text: 'Thinking'});
		const dots = thinking.createSpan({cls: 'synapse-thinking-dots'});
		dots.createSpan({cls: 'synapse-dot', text: '.'});
		dots.createSpan({cls: 'synapse-dot', text: '.'});
		dots.createSpan({cls: 'synapse-dot', text: '.'});

		// Clean up any previous streaming component
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.streamingComponent = this.addChild(new Component());

		this.streamingBodyEl = body;
		this.streamingWrapperEl = bodyWrapper;
		this.scrollToBottom();
	};

	proto.showProcessingIndicator = function (): void {
		if (!this.streamingBodyEl) return;
		// Remove any existing thinking/processing indicator
		const existing = this.streamingBodyEl.querySelector('.synapse-thinking');
		if (existing) existing.remove();
		const processing = this.streamingBodyEl.createDiv({cls: 'synapse-thinking'});
		processing.createSpan({text: 'Processing'});
		const dots = processing.createSpan({cls: 'synapse-thinking-dots'});
		dots.createSpan({cls: 'synapse-dot', text: '.'});
		dots.createSpan({cls: 'synapse-dot', text: '.'});
		dots.createSpan({cls: 'synapse-dot', text: '.'});
	};

	proto.removeProcessingIndicator = function (): void {
		if (!this.streamingBodyEl) return;
		const indicator = this.streamingBodyEl.querySelector('.synapse-thinking');
		if (indicator) indicator.remove();
	};

	// ── Streaming ────────────────────────────────────────────────

	proto.appendDelta = function (delta: string): void {
		this.streamingContent += delta;
		// Remove processing indicator once real content starts streaming
		this.removeProcessingIndicator();
		if (!this.renderScheduled) {
			this.renderScheduled = true;
			window.requestAnimationFrame(() => {
				this.renderScheduled = false;
				this.updateStreamingRenderIncremental();
			});
		}
	};

	// ── Reasoning streaming ──────────────────────────────────────

	proto.startReasoningBlock = function (): void {
		if (this.reasoningEl && !this.reasoningEl.isConnected) {
			this.reasoningEl = null;
			this.reasoningBodyEl = null;
		}
		if (!this.streamingWrapperEl || !this.streamingBodyEl || this.reasoningEl) return;

		// Remove the thinking placeholder from the answer body
		const thinking = this.streamingBodyEl?.querySelector('.synapse-thinking');
		if (thinking) thinking.remove();

		const details = document.createElement('details') as HTMLDetailsElement;
		details.className = 'synapse-reasoning';
		details.open = true;

		const summary = document.createElement('summary');
		summary.className = 'synapse-reasoning-summary';
		const spinner = document.createElement('span');
		spinner.className = 'synapse-reasoning-spinner';
		summary.appendChild(spinner);
		summary.appendChild(document.createTextNode('Thinking\u2026'));
		details.appendChild(summary);

		const body = document.createElement('div');
		body.className = 'synapse-reasoning-body';
		details.appendChild(body);

		// Insert before the answer body element
		this.streamingWrapperEl.insertBefore(details, this.streamingBodyEl);
		this.reasoningEl = details;
		this.reasoningBodyEl = body;
	};

	proto.appendReasoningDelta = function (delta: string): void {
		if (!this.reasoningEl) {
			this.startReasoningBlock();
		}
		this.reasoningComplete = false;
		this.streamingReasoning += delta;
		if (this.reasoningBodyEl) {
			this.reasoningBodyEl.appendText(delta);
		}
		if (!this.fullReasoningRenderTimer) {
			this.fullReasoningRenderTimer = setTimeout(() => {
				this.fullReasoningRenderTimer = null;
				void this.doFullReasoningRender();
			}, 300);
		}
		this.scrollToBottom();
	};

	proto.syncReasoningContent = function (content: string): void {
		if (!content) return;
		if (!this.reasoningEl) {
			this.startReasoningBlock();
		}
		this.streamingReasoning = content;
		if (this.fullReasoningRenderTimer) {
			clearTimeout(this.fullReasoningRenderTimer);
			this.fullReasoningRenderTimer = null;
		}
		void this.doFullReasoningRender();
	};

	proto.doFullReasoningRender = async function (): Promise<void> {
		if (!this.reasoningBodyEl || !this.reasoningBodyEl.isConnected || !this.streamingReasoning) return;
		this.reasoningBodyEl.empty();
		await renderMarkdownSafe(this.app, this.streamingReasoning, this.reasoningBodyEl, this.streamingComponent ?? this);
		this.scrollToBottom();
	};

	proto.finalizeReasoning = function (): void {
		if (this.reasoningComplete) return;
		this.reasoningComplete = true;

		// Cancel pending incremental render and do a final full render
		if (this.fullReasoningRenderTimer) {
			clearTimeout(this.fullReasoningRenderTimer);
			this.fullReasoningRenderTimer = null;
		}
		void this.doFullReasoningRender();

		if (this.reasoningEl) {
			// Collapse the block
			this.reasoningEl.removeAttribute('open');
			// Swap spinner for a static icon and change label
			const summary = this.reasoningEl.querySelector<HTMLElement>('summary');
			if (summary) {
				summary.empty();
				const iconEl = summary.createSpan({cls: 'synapse-reasoning-icon'});
				setIcon(iconEl, 'lightbulb');
				summary.appendText('Reasoning');
			}
		}

		// Restore the thinking indicator in the answer body if no answer content has arrived yet
		if (!this.streamingContent && this.streamingBodyEl) {
			const thinking = this.streamingBodyEl.createDiv({cls: 'synapse-thinking'});
			thinking.createSpan({text: 'Thinking'});
			const dots = thinking.createSpan({cls: 'synapse-thinking-dots'});
			dots.createSpan({cls: 'synapse-dot', text: '.'});
			dots.createSpan({cls: 'synapse-dot', text: '.'});
			dots.createSpan({cls: 'synapse-dot', text: '.'});
		}
	};

	proto.clearReasoningState = function (): void {
		if (this.fullReasoningRenderTimer) {
			clearTimeout(this.fullReasoningRenderTimer);
			this.fullReasoningRenderTimer = null;
		}
		this.streamingReasoning = '';
		this.reasoningEl = null;
		this.reasoningBodyEl = null;
		this.reasoningComplete = false;
	};

	/**
	 * Append only the new delta text as a plain text node.
	 * A periodic timer does full markdown re-renders every 300ms
	 * to resolve cross-boundary syntax (code blocks, lists, etc.).
	 */
	proto.updateStreamingRenderIncremental = function (): void {
		if (!this.streamingBodyEl) return;

		const newText = this.streamingContent.slice(this.lastFullRenderLen);
		if (newText) {
			// Append raw text node for immediate visual feedback
			this.streamingBodyEl.appendText(newText);
			this.lastFullRenderLen = this.streamingContent.length;
		}

		// Schedule a periodic full re-render if not already scheduled
		if (!this.fullRenderTimer) {
			this.fullRenderTimer = setTimeout(() => {
				this.fullRenderTimer = null;
				void this.doFullStreamingRender();
			}, 300);
		}

		this.scrollToBottom();
	};

	/** Full markdown re-render of the entire streamed content so far. */
	proto.doFullStreamingRender = async function (): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await renderMarkdownSafe(this.app, this.streamingContent, this.streamingBodyEl, this.streamingComponent ?? this);
		this.lastFullRenderLen = this.streamingContent.length;
		this.scrollToBottom();
	};

	proto.updateStreamingRender = async function (): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await renderMarkdownSafe(this.app, this.streamingContent, this.streamingBodyEl, this.streamingComponent ?? this);
		this.scrollToBottom();
	};

	proto.finalizeStreamingMessage = function (): void {
		// Always remove any lingering thinking/processing indicator
		this.removeProcessingIndicator();
		if (this.streamingReasoning && !this.reasoningComplete) {
			this.finalizeReasoning();
		}

		if (this.streamingContent || this.streamingReasoning) {
			const msg: ChatMessage = {
				id: `a-${Date.now()}`,
				role: 'assistant',
				content: this.streamingContent,
				reasoning: this.streamingReasoning || undefined,
				timestamp: Date.now(),
			};
			this.messages.push(msg);
		}

		// Clean up incremental render timer and do final full render
		if (this.fullRenderTimer) {
			clearTimeout(this.fullRenderTimer);
			this.fullRenderTimer = null;
		}
		if (this.streamingBodyEl && this.streamingContent) {
			this.streamingBodyEl.empty();
			void renderMarkdownSafe(this.app, this.streamingContent, this.streamingBodyEl, this.streamingComponent ?? this);
		} else if (this.streamingBodyEl && !this.streamingContent && !this.streamingReasoning) {
			// No text was streamed — show a subtle fallback
			this.streamingBodyEl.empty();
			this.streamingBodyEl.createDiv({
				cls: 'synapse-thinking synapse-cancelled',
				text: 'No response',
			});
		}
		this.lastFullRenderLen = 0;

		// Render metadata footer
		this.renderMessageMetadata();

		// Freeze the task panel's elapsed label at its final value, then stop live-tracking it —
		// the DOM itself is left in place (part of the finalized message).
		this.updateTaskPanelElapsed();
		this.clearTaskPanelState();

		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();

		this.clearReasoningState();

		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}

		// Reset turn metadata
		this.turnStartTime = 0;
		this.turnToolsUsed = [];
		this.turnSkillsUsed = [];
		this.turnUsage = null;

		this.isStreaming = false;
		this.updateSendButton();

		// Update local session timestamp instead of full SDK round-trip
		if (this.currentSessionId) {
			const entry = this.sessionList.find(s => s.sessionId === this.currentSessionId);
			if (entry) {
				entry.lastModified = Date.now();
			}
		}
		this.renderSessionList();
	};

	proto.renderMessageMetadata = function (): void {
		if (!this.streamingWrapperEl) return;

		const hasTime = this.turnStartTime > 0;
		const hasTokens = this.turnUsage !== null;
		const uniqueTools = [...new Set(this.turnToolsUsed)];
		const hasTools = uniqueTools.length > 0;
		const uniqueSkills = [...new Set(this.turnSkillsUsed)];
		const hasSkills = uniqueSkills.length > 0;

		if (!hasTime && !hasTokens && !hasTools && !hasSkills) return;

		const footer = this.streamingWrapperEl.createDiv({cls: 'synapse-msg-metadata'});

		// Elapsed time
		if (hasTime) {
			const elapsed = Date.now() - this.turnStartTime;
			const timeText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
			const timeSpan = footer.createSpan({cls: 'synapse-metadata-item'});
			const timeIcon = timeSpan.createSpan({cls: 'synapse-metadata-icon'});
			setIcon(timeIcon, 'clock');
			timeSpan.appendText(timeText);
		}

		// Token usage — show rounded total, detail on hover
		if (hasTokens) {
			const u = this.turnUsage!;
			const total = u.inputTokens + u.cacheReadTokens + u.outputTokens;
			const rounded = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
			const tooltipLines: string[] = [];
			if (u.model) tooltipLines.push(`Model: ${u.model}`);
			tooltipLines.push(`Input: ${u.inputTokens}`);
			tooltipLines.push(`Output: ${u.outputTokens}`);
			if (u.cacheReadTokens > 0) tooltipLines.push(`Cached: ${u.cacheReadTokens}`);
			if (u.cacheWriteTokens > 0) tooltipLines.push(`Cache write: ${u.cacheWriteTokens}`);
			const tokenSpan = footer.createSpan({cls: 'synapse-metadata-item'});
			const tokenIcon = tokenSpan.createSpan({cls: 'synapse-metadata-icon'});
			setIcon(tokenIcon, 'hash');
			tokenSpan.appendText(`${rounded} tokens`);
			tokenSpan.setAttribute('title', tooltipLines.join('\n'));
		}

		// Tools used
		if (hasTools) {
			const toolSpan = footer.createSpan({cls: 'synapse-metadata-item synapse-metadata-tools'});
			const toolIcon = toolSpan.createSpan({cls: 'synapse-metadata-icon'});
			setIcon(toolIcon, 'wrench');
			const toolLabel = uniqueTools.length === 1 ? '1 tool' : `${uniqueTools.length} tools`;
			toolSpan.appendText(toolLabel);
			toolSpan.setAttribute('title', uniqueTools.join('\n'));
		}

		// Skills used
		if (hasSkills) {
			const skillSpan = footer.createSpan({cls: 'synapse-metadata-item synapse-metadata-tools'});
			const skillIcon = skillSpan.createSpan({cls: 'synapse-metadata-icon'});
			setIcon(skillIcon, 'wand-2');
			const skillLabel = uniqueSkills.length === 1 ? '1 skill' : `${uniqueSkills.length} skills`;
			skillSpan.appendText(skillLabel);
			skillSpan.setAttribute('title', uniqueSkills.join('\n'));
		}
	};

	proto.addToolCallBlock = function (toolCallId: string, toolName: string, args?: unknown): void {
		if (!this.toolCallsContainer) return;

		const details = this.toolCallsContainer.createEl('details', {cls: 'synapse-tool-call'});
		const summary = details.createEl('summary', {cls: 'synapse-tool-call-summary'});
		const iconEl = summary.createSpan({cls: 'synapse-tool-call-icon'});
		setIcon(iconEl, 'wrench');
		summary.createSpan({cls: 'synapse-tool-call-name', text: toolName});
		const spinner = summary.createSpan({cls: 'synapse-tool-call-spinner'});
		setIcon(spinner, 'loader');

		// Input section
		if (args && Object.keys(args as Record<string, unknown>).length > 0) {
			const inputSection = details.createDiv({cls: 'synapse-tool-call-section'});
			inputSection.createDiv({cls: 'synapse-tool-call-label', text: 'Input'});
			const pre = inputSection.createEl('pre', {cls: 'synapse-tool-call-code'});
			pre.createEl('code', {text: JSON.stringify(args, null, 2)});
		}

		this.activeToolCalls.set(toolCallId, {toolName, detailsEl: details});

		// Show "Processing ..." animation while tools are running
		this.showProcessingIndicator();

		this.scrollToBottom();
	};

	proto.completeToolCallBlock = function (toolCallId: string, success: boolean, result?: {content?: string; detailedContent?: string}, error?: {message: string}): void {
		const entry = this.activeToolCalls.get(toolCallId);
		if (!entry) return;

		const {detailsEl} = entry;

		// Remove spinner, add status icon
		const spinner = detailsEl.querySelector('.synapse-tool-call-spinner');
		if (spinner) spinner.remove();
		const summaryEl = detailsEl.querySelector('summary');
		if (summaryEl) {
			const statusEl = summaryEl.createSpan({cls: `synapse-tool-call-status ${success ? 'is-success' : 'is-error'}`});
			setIcon(statusEl, success ? 'check' : 'x');
		}

		// Output section
		const output = error ? `Error: ${error.message}` : (result?.detailedContent || result?.content || '');
		if (output) {
			const outputSection = detailsEl.createDiv({cls: 'synapse-tool-call-section'});
			outputSection.createDiv({cls: 'synapse-tool-call-label', text: success ? 'Output' : 'Error'});
			const pre = outputSection.createEl('pre', {cls: 'synapse-tool-call-code'});
			const displayText = output.length > MAX_DEBUG_DISPLAY_LEN ? output.slice(0, MAX_DEBUG_DISPLAY_LEN) + '\n… (truncated)' : output;
			pre.createEl('code', {text: displayText});
		}

		this.activeToolCalls.delete(toolCallId);
		this.scrollToBottom();
	};

	// ── Task/plan tracking (TodoWrite) ──────────────────────────

	const TASK_STATUS_ICON: Record<TodoItem['status'], string> = {
		pending: 'circle',
		in_progress: 'loader',
		completed: 'check-circle-2',
	};

	/**
	 * Render (or replace) the live task-tracking panel for the current turn. Each `TodoWrite`
	 * call is the *current* full plan state, so this always rebuilds the panel from scratch
	 * rather than appending — there is exactly one live panel per turn.
	 */
	proto.renderTaskPanel = function (todos: TodoItem[]): void {
		if (!this.toolCallsContainer) return;

		if (!this.taskPanelEl || !this.taskPanelEl.isConnected) {
			this.taskPanelEl = this.toolCallsContainer.createDiv({cls: 'synapse-task-panel'});
			// Keep the panel first among tool blocks — the plan is the headline, tool calls are detail.
			this.toolCallsContainer.prepend(this.taskPanelEl);
		}
		this.currentTodos = todos;

		const panel = this.taskPanelEl;
		panel.empty();

		const header = panel.createDiv({cls: 'synapse-task-panel-header'});
		header.createSpan({cls: 'synapse-task-panel-title', text: 'Plan'});
		const elapsedSpan = header.createSpan({cls: 'synapse-task-panel-elapsed'});
		elapsedSpan.setAttribute('data-synapse-task-elapsed', 'true');

		const list = panel.createDiv({cls: 'synapse-task-list'});
		for (const todo of todos) {
			const item = list.createDiv({cls: `synapse-task-item is-${todo.status}`});
			const iconEl = item.createSpan({cls: 'synapse-task-item-icon'});
			setIcon(iconEl, TASK_STATUS_ICON[todo.status]);
			const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
			item.createSpan({cls: 'synapse-task-item-label', text: label});
		}

		this.updateTaskPanelElapsed();
		if (!this.taskPanelTimer) {
			const timerId = window.setInterval(() => this.updateTaskPanelElapsed(), 1000);
			this.taskPanelTimer = timerId as unknown as ReturnType<typeof setInterval>;
			this.registerInterval(timerId);
		}

		this.scrollToBottom();
	};

	/** Refresh the live elapsed-runtime label in the current task panel, if any is shown. */
	proto.updateTaskPanelElapsed = function (): void {
		if (!this.taskPanelEl || !this.taskPanelEl.isConnected || this.turnStartTime === 0) return;
		const elapsedSpan = this.taskPanelEl.querySelector('[data-synapse-task-elapsed]');
		if (!elapsedSpan) return;
		const elapsed = Date.now() - this.turnStartTime;
		const timeText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
		elapsedSpan.textContent = timeText;
	};

	/** Reset task-panel state (called on turn finalize, new conversation, and session switches). */
	proto.clearTaskPanelState = function (): void {
		if (this.taskPanelTimer) {
			window.clearInterval(this.taskPanelTimer as unknown as number);
			this.taskPanelTimer = null;
		}
		this.taskPanelEl = null;
		this.currentTodos = null;
	};

	// ── Compaction debug blocks ─────────────────────────────────

	proto.addCompactionStartBlock = function (data: {conversationTokens?: number; systemTokens?: number; toolDefinitionsTokens?: number}): void {
		if (!this.toolCallsContainer) return;

		const details = this.toolCallsContainer.createEl('details', {cls: 'synapse-compaction-block'});
		const summary = details.createEl('summary', {cls: 'synapse-compaction-summary'});
		const iconEl = summary.createSpan({cls: 'synapse-compaction-icon'});
		setIcon(iconEl, 'archive');
		summary.createSpan({text: 'Compaction started'});
		const spinner = summary.createSpan({cls: 'synapse-tool-call-spinner'});
		setIcon(spinner, 'loader');

		const body = details.createDiv({cls: 'synapse-compaction-body'});
		const lines: string[] = [];
		if (data.conversationTokens != null) lines.push(`Conversation tokens: ${data.conversationTokens.toLocaleString()}`);
		if (data.systemTokens != null) lines.push(`System tokens: ${data.systemTokens.toLocaleString()}`);
		if (data.toolDefinitionsTokens != null) lines.push(`Tool definition tokens: ${data.toolDefinitionsTokens.toLocaleString()}`);
		if (lines.length > 0) {
			const pre = body.createEl('pre', {cls: 'synapse-tool-call-code'});
			pre.createEl('code', {text: lines.join('\n')});
		}

		this.scrollToBottom();
	};

	proto.addCompactionCompleteBlock = function (data: {success: boolean; tokensRemoved?: number; messagesRemoved?: number; summaryContent?: string; preCompactionTokens?: number; postCompactionTokens?: number; error?: string}): void {
		if (!this.toolCallsContainer) return;

		// Try to update the existing compaction_start block's spinner
		const blocks = Array.from(this.toolCallsContainer.querySelectorAll('.synapse-compaction-block'));
		const startBlock = blocks.reverse().find(b => b.querySelector('.synapse-tool-call-spinner'));
		if (startBlock) {
			const spinner = startBlock.querySelector('.synapse-tool-call-spinner');
			if (spinner) spinner.remove();
			const summaryEl = startBlock.querySelector('summary');
			if (summaryEl) {
				const statusEl = summaryEl.createSpan({cls: `synapse-tool-call-status ${data.success ? 'is-success' : 'is-error'}`});
				setIcon(statusEl, data.success ? 'check' : 'x');
			}
		}

		const details = this.toolCallsContainer.createEl('details', {cls: 'synapse-compaction-block'});
		const summary = details.createEl('summary', {cls: 'synapse-compaction-summary'});
		const iconEl = summary.createSpan({cls: 'synapse-compaction-icon'});
		setIcon(iconEl, 'archive');
		summary.createSpan({text: data.success ? 'Compaction complete' : 'Compaction failed'});
		const statusEl = summary.createSpan({cls: `synapse-tool-call-status ${data.success ? 'is-success' : 'is-error'}`});
		setIcon(statusEl, data.success ? 'check' : 'x');

		const body = details.createDiv({cls: 'synapse-compaction-body'});
		const lines: string[] = [];
		if (data.success) {
			if (data.preCompactionTokens != null) lines.push(`Pre-compaction tokens: ${data.preCompactionTokens.toLocaleString()}`);
			if (data.postCompactionTokens != null) lines.push(`Post-compaction tokens: ${data.postCompactionTokens.toLocaleString()}`);
			const tokensRemoved = data.tokensRemoved ?? (data.preCompactionTokens != null && data.postCompactionTokens != null ? data.preCompactionTokens - data.postCompactionTokens : undefined);
			if (tokensRemoved != null) lines.push(`Tokens removed: ${tokensRemoved.toLocaleString()}`);
			if (data.messagesRemoved != null) lines.push(`Messages removed: ${data.messagesRemoved}`);
		} else {
			if (data.error) lines.push(`Error: ${data.error}`);
		}
		if (lines.length > 0) {
			const pre = body.createEl('pre', {cls: 'synapse-tool-call-code'});
			pre.createEl('code', {text: lines.join('\n')});
		}
		if (data.summaryContent) {
			body.createDiv({cls: 'synapse-compaction-label', text: 'Summary'});
			const summaryPre = body.createEl('pre', {cls: 'synapse-tool-call-code'});
			const displayText = data.summaryContent.length > MAX_DEBUG_DISPLAY_LEN ? data.summaryContent.slice(0, MAX_DEBUG_DISPLAY_LEN) + '\n… (truncated)' : data.summaryContent;
			summaryPre.createEl('code', {text: displayText});
		}

		this.scrollToBottom();
	};

	proto.renderWelcome = function (): void {
		const welcome = this.chatContainer.createDiv({cls: 'synapse-welcome'});
		const icon = welcome.createDiv({cls: 'synapse-welcome-icon'});
		setIcon(icon, SYNAPSE_ICON_ID);
		welcome.createEl('h3', {text: 'Synapse'});
		welcome.createEl('p', {
			text: 'Your AI-powered second brain. Select an agent, choose a model, configure tools and get the job done!',
			cls: 'synapse-welcome-desc',
		});
	};

	proto.updateSendButton = function (): void {
		this.sendBtn.empty();
		if (this.isStreaming) {
			setIcon(this.sendBtn, 'square');
			this.sendBtn.title = 'Stop';
			this.sendBtn.addClass('is-streaming');
		} else {
			setIcon(this.sendBtn, 'arrow-up');
			this.sendBtn.title = 'Send message';
			this.sendBtn.removeClass('is-streaming');
		}
	};
}
