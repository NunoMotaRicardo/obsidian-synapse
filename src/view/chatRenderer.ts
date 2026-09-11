import {
	Component,
	MarkdownView,
	Notice,
	TFile,
	TFolder,
	normalizePath,
	setIcon,
} from 'obsidian';
import {SYNAPSE_ICON_ID} from '../main';
import {isImageAttachment, type ChatMessage, type ChatAttachment} from '../types';
import {renderMarkdownSafe} from './utils';
import type {TodoItem} from '../agentService';
import type {ViewContext} from './types';
import {debugTrace} from '../debug';

const MAX_DEBUG_DISPLAY_LEN = 5000;

/**
 * Create a `.synapse-thinking` waiting/status indicator with the given label and animated dots.
 * Used both for the pre-content waiting placeholder and the mid-turn "Processing" indicator —
 * the label is the only thing that varies, so callers should not claim "Thinking" unless
 * reasoning is actually underway (see `addAssistantPlaceholder` / `finalizeReasoning`).
 */
function createThinkingIndicator(parent: HTMLElement, label: string): HTMLElement {
	const indicator = parent.createDiv({cls: 'synapse-thinking'});
	indicator.createSpan({text: label});
	const dots = indicator.createSpan({cls: 'synapse-thinking-dots'});
	dots.createSpan({cls: 'synapse-dot', text: '.'});
	dots.createSpan({cls: 'synapse-dot', text: '.'});
	dots.createSpan({cls: 'synapse-dot', text: '.'});
	return indicator;
}

const MAX_TOOL_ARG_SUMMARY_LEN = 120;

/** Format a compact inline single-line summary of tool arguments for the monospace ledger rail. */
export function formatToolArgsSummary(args: unknown): string {
	if (!args || typeof args !== 'object') return '';
	const record = args as Record<string, unknown>;
	const primaryKeys = [
		'path', 'file_path', 'filePath', 'SearchPath', 'searchPath',
		'pattern', 'Pattern', 'query', 'Query',
		'command', 'CommandLine', 'commandLine', 'cmd',
		'url', 'Url', 'prompt', 'Prompt', 'description', 'Description',
	];
	for (const key of primaryKeys) {
		const val = record[key];
		if (typeof val === 'string' && val.trim().length > 0) {
			const cleaned = val.replace(/\s+/g, ' ').trim();
			return cleaned.length > MAX_TOOL_ARG_SUMMARY_LEN
				? cleaned.slice(0, MAX_TOOL_ARG_SUMMARY_LEN - 1) + '\u2026'
				: cleaned;
		}
	}
	return '';
}

/** Status column labels for the task panel (uppercase presentation via CSS). */
const TASK_STATUS_LABEL: Record<TodoItem['status'], string> = {
	pending: 'TODO',
	in_progress: 'ACTIVE',
	completed: 'DONE',
};

/**
 * Chat-message rendering controller (composition refactor — formerly prototype injection
 * into `SynapseView`, `.docs/research/2026-09-11-view-composition-refactor.md`). Owns the
 * *behavior* of chat-message rendering — message bubbles, the streaming placeholder, the
 * reasoning block, tool-call/compaction/task-panel blocks, metadata footers, and the send
 * button's icon — while the streaming-lifecycle *state* (`streamingContent`,
 * `streamingReasoning`, `streamingBodyEl`, `toolCallsContainer`, `activeToolCalls`, the
 * task-plan maps, turn metadata, …) stays on `SynapseView` for now: `sessionSidebar.ts`
 * still reads and writes those fields directly when a session goes to the background, and
 * that module is not converted yet (step 5). All such state is reached through
 * `this.view.view.<x>` (see `ViewContext` in `view/types.ts`).
 */
export class ChatRendererController {
	constructor(private view: ViewContext) {}

	addUserMessage(content: string, attachments: ChatAttachment[], scopePaths: string[]): void {
		// Combine file/clipboard attachments with scope path entries for display
		const allAttachments = [...attachments];
		for (const sp of scopePaths) {
			const displayName = sp === '/' ? this.view.app.vault.getName() : sp;
			const abstract = sp === '/'
				? this.view.app.vault.getRoot()
				: this.view.app.vault.getAbstractFileByPath(sp);
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
		this.view.view.messages.push(msg);
		void this.renderMessageBubble(msg);
		this.view.scrollToBottom();
	}

	addInfoMessage(text: string): void {
		const msg: ChatMessage = {id: `i-${Date.now()}`, role: 'info', content: text, timestamp: Date.now()};
		this.view.view.messages.push(msg);
		void this.renderMessageBubble(msg);
		this.view.scrollToBottom();
	}

	async renderMessageBubble(msg: ChatMessage): Promise<void> {
		if (msg.role === 'info') {
			const el = this.view.chatContainer.createDiv({cls: 'synapse-msg synapse-msg-info'});
			el.createSpan({text: msg.content});
			return;
		}

		// Speaker label
		const speakerCls = msg.role === 'user' ? 'you' : 'ai';
		const speakerText = msg.role === 'user' ? 'You' : 'Synapse';
		const speakerId = `synapse-speaker-${msg.id || Date.now()}`;
		this.view.chatContainer.createDiv({
			cls: `synapse-speaker synapse-label-base ${speakerCls}`,
			text: speakerText,
			attr: {id: speakerId},
		});

		const wrapper = this.view.chatContainer.createDiv({
			cls: `synapse-msg synapse-msg-${msg.role}`,
			attr: {'aria-labelledby': speakerId},
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
							const {shell} = window.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
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
							const {shell} = window.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							const absPath = this.view.getVaultBasePath() + '/' + vaultPath;
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
							? this.view.app.vault.getRoot()
							: this.view.app.vault.getAbstractFileByPath(att.path!);
						if (folder) {
							// Reveal the folder in Obsidian's file explorer
							const fileExplorer = this.view.app.workspace.getLeavesOfType('file-explorer')[0];
							if (fileExplorer) {
								void this.view.app.workspace.revealLeaf(fileExplorer);
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
						const file = this.view.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							const leaf = this.view.app.workspace.getLeaf(false);
							void leaf.openFile(file).then(() => {
								if (selRange) {
									const mdView = this.view.app.workspace.getActiveViewOfType(MarkdownView);
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
						const file = this.view.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							void this.view.app.workspace.getLeaf(false).openFile(file);
						}
					});
				}
			}
		}

		if (msg.role === 'assistant' && msg.reasoning) {
			await this.renderReasoningBlock(msg.reasoning, bodyWrapper);
		}

		const body = bodyWrapper.createDiv({cls: 'synapse-msg-body'});

		if (msg.role === 'assistant') {
			await renderMarkdownSafe(this.view.app, msg.content, body, this.view.view.streamingComponent ?? this.view.view);
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
				window.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
			});
		}
	}

	private async renderReasoningBlock(reasoning: string, parent: HTMLElement): Promise<void> {
		const details = parent.createEl('details', {cls: 'synapse-reasoning'});
		details.createEl('summary', {cls: 'synapse-reasoning-summary synapse-label-base', text: 'Reasoning'});
		const body = details.createDiv({cls: 'synapse-reasoning-body'});
		await renderMarkdownSafe(this.view.app, reasoning, body, this.view.view.streamingComponent ?? this.view.view);
	}

	/**
	 * Render user message content.
	 */
	private renderUserMessageContent(content: string, body: HTMLElement): void {
		body.createEl('p', {text: content});
	}

	addAssistantPlaceholder(): void {
		const speakerId = `synapse-speaker-placeholder-${Date.now()}`;
		this.view.chatContainer.createDiv({
			cls: 'synapse-speaker synapse-label-base ai',
			text: 'Synapse',
			attr: {id: speakerId},
		});

		const wrapper = this.view.chatContainer.createDiv({
			cls: 'synapse-msg synapse-msg-assistant',
			attr: {'aria-labelledby': speakerId},
		});

		const bodyWrapper = wrapper.createDiv({cls: 'synapse-msg-body-wrapper'});

		// Container for collapsible tool call blocks
		this.view.view.toolCallsContainer = bodyWrapper.createDiv({cls: 'synapse-tool-calls'});

		const body = bodyWrapper.createDiv({cls: 'synapse-msg-body'});
		// Honest default copy: no reasoning has streamed yet, so don't claim "Thinking" —
		// that label is reserved for the reasoning block once it actually starts (startReasoningBlock).
		createThinkingIndicator(body, 'Waiting for response…');

		// Clean up any previous streaming component
		if (this.view.view.streamingComponent) {
			this.view.view.removeChild(this.view.view.streamingComponent);
			this.view.view.streamingComponent = null;
		}
		this.view.view.streamingComponent = this.view.view.addChild(new Component());

		this.view.view.streamingBodyEl = body;
		this.view.view.streamingWrapperEl = bodyWrapper;
		this.view.scrollToBottom();
	}

	private showProcessingIndicator(): void {
		if (!this.view.view.streamingBodyEl) return;
		// Remove any existing thinking/processing indicator
		const existing = this.view.view.streamingBodyEl.querySelector('.synapse-thinking');
		if (existing) existing.remove();
		createThinkingIndicator(this.view.view.streamingBodyEl, 'Processing');
	}

	private removeProcessingIndicator(): void {
		if (!this.view.view.streamingBodyEl) return;
		const indicator = this.view.view.streamingBodyEl.querySelector('.synapse-thinking');
		if (indicator) indicator.remove();
	}

	// ── Streaming ────────────────────────────────────────────────

	appendDelta(delta: string): void {
		this.view.view.streamingContent += delta;
		// Remove processing indicator once real content starts streaming
		this.removeProcessingIndicator();
		if (!this.view.view.renderScheduled) {
			this.view.view.renderScheduled = true;
			window.requestAnimationFrame(() => {
				this.view.view.renderScheduled = false;
				this.updateStreamingRenderIncremental();
			});
		}
	}

	// ── Reasoning streaming ──────────────────────────────────────

	private startReasoningBlock(): void {
		if (this.view.view.reasoningEl && !this.view.view.reasoningEl.isConnected) {
			this.view.view.reasoningEl = null;
			this.view.view.reasoningBodyEl = null;
		}
		if (this.view.view.reasoningEl) return;
		if (!this.view.view.streamingWrapperEl || !this.view.view.streamingBodyEl) {
			debugTrace('Synapse: startReasoningBlock called with no streaming wrapper/body — reasoning deltas will accumulate without rendering.');
			return;
		}

		// Remove the thinking placeholder from the answer body
		const thinking = this.view.view.streamingBodyEl?.querySelector('.synapse-thinking');
		if (thinking) thinking.remove();

		const details = createEl('details');
		details.className = 'synapse-reasoning is-live';
		details.open = true;

		const summary = createEl('summary');
		summary.className = 'synapse-reasoning-summary synapse-label-base';
		summary.appendChild(document.createTextNode('Thinking\u2026'));
		details.appendChild(summary);

		const body = createDiv();
		body.className = 'synapse-reasoning-body';
		details.appendChild(body);

		// Insert before the answer body element
		this.view.view.streamingWrapperEl.insertBefore(details, this.view.view.streamingBodyEl);
		this.view.view.reasoningEl = details;
		this.view.view.reasoningBodyEl = body;
	}

	appendReasoningDelta(delta: string): void {
		if (!this.view.view.reasoningEl) {
			this.startReasoningBlock();
		}
		this.view.view.reasoningComplete = false;
		this.view.view.streamingReasoning += delta;
		if (this.view.view.reasoningBodyEl) {
			this.view.view.reasoningBodyEl.appendText(delta);
		}
		if (!this.view.view.fullReasoningRenderTimer) {
			this.view.view.fullReasoningRenderTimer = window.setTimeout(() => {
				this.view.view.fullReasoningRenderTimer = null;
				void this.doFullReasoningRender();
			}, 300);
		}
		this.view.scrollToBottom();
	}

	syncReasoningContent(content: string): void {
		if (!content) return;
		if (!this.view.view.reasoningEl) {
			this.startReasoningBlock();
		}
		this.view.view.streamingReasoning = content;
		if (this.view.view.fullReasoningRenderTimer) {
			window.clearTimeout(this.view.view.fullReasoningRenderTimer);
			this.view.view.fullReasoningRenderTimer = null;
		}
		void this.doFullReasoningRender();
	}

	private async doFullReasoningRender(): Promise<void> {
		if (!this.view.view.reasoningBodyEl || !this.view.view.reasoningBodyEl.isConnected || !this.view.view.streamingReasoning) return;
		this.view.view.reasoningBodyEl.empty();
		await renderMarkdownSafe(this.view.app, this.view.view.streamingReasoning, this.view.view.reasoningBodyEl, this.view.view.streamingComponent ?? this.view.view);
		this.view.scrollToBottom();
	}

	finalizeReasoning(): void {
		if (this.view.view.reasoningComplete) return;
		this.view.view.reasoningComplete = true;

		// Cancel pending incremental render and do a final full render
		if (this.view.view.fullReasoningRenderTimer) {
			window.clearTimeout(this.view.view.fullReasoningRenderTimer);
			this.view.view.fullReasoningRenderTimer = null;
		}
		void this.doFullReasoningRender();

		if (this.view.view.reasoningEl) {
			this.view.view.reasoningEl.removeClass('is-live');
			// Collapse the block
			this.view.view.reasoningEl.removeAttribute('open');
			const summary = this.view.view.reasoningEl.querySelector<HTMLElement>('summary');
			if (summary) {
				summary.empty();
				summary.appendText('Reasoning');
			}
		}

		// Reasoning is complete but no answer text has arrived yet — show a waiting indicator
		// consistent with the pre-reasoning placeholder (reasoning itself already reported its
		// own "Thinking…" state above; this is just "still waiting for the answer").
		if (!this.view.view.streamingContent && this.view.view.streamingBodyEl) {
			createThinkingIndicator(this.view.view.streamingBodyEl, 'Waiting for response…');
		}
	}

	clearReasoningState(): void {
		if (this.view.view.fullReasoningRenderTimer) {
			window.clearTimeout(this.view.view.fullReasoningRenderTimer);
			this.view.view.fullReasoningRenderTimer = null;
		}
		this.view.view.streamingReasoning = '';
		this.view.view.reasoningEl = null;
		this.view.view.reasoningBodyEl = null;
		this.view.view.reasoningComplete = false;
	}

	/**
	 * Append only the new delta text as a plain text node.
	 * A periodic timer does full markdown re-renders every 300ms
	 * to resolve cross-boundary syntax (code blocks, lists, etc.).
	 */
	private updateStreamingRenderIncremental(): void {
		if (!this.view.view.streamingBodyEl) return;

		const newText = this.view.view.streamingContent.slice(this.view.view.lastFullRenderLen);
		if (newText) {
			// Append raw text node for immediate visual feedback
			this.view.view.streamingBodyEl.appendText(newText);
			this.view.view.lastFullRenderLen = this.view.view.streamingContent.length;
		}

		// Schedule a periodic full re-render if not already scheduled
		if (!this.view.view.fullRenderTimer) {
			this.view.view.fullRenderTimer = window.setTimeout(() => {
				this.view.view.fullRenderTimer = null;
				void this.doFullStreamingRender();
			}, 300);
		}

		this.view.scrollToBottom();
	}

	/** Full markdown re-render of the entire streamed content so far. */
	private async doFullStreamingRender(): Promise<void> {
		if (!this.view.view.streamingBodyEl) return;
		this.view.view.streamingBodyEl.empty();
		await renderMarkdownSafe(this.view.app, this.view.view.streamingContent, this.view.view.streamingBodyEl, this.view.view.streamingComponent ?? this.view.view);
		this.view.view.lastFullRenderLen = this.view.view.streamingContent.length;
		this.view.scrollToBottom();
	}

	async updateStreamingRender(): Promise<void> {
		if (!this.view.view.streamingBodyEl) return;
		this.view.view.streamingBodyEl.empty();
		await renderMarkdownSafe(this.view.app, this.view.view.streamingContent, this.view.view.streamingBodyEl, this.view.view.streamingComponent ?? this.view.view);
		this.view.scrollToBottom();
	}

	finalizeStreamingMessage(): void {
		// Always remove any lingering thinking/processing indicator
		this.removeProcessingIndicator();
		if (this.view.view.streamingReasoning && !this.view.view.reasoningComplete) {
			this.finalizeReasoning();
		}

		if (this.view.view.streamingContent || this.view.view.streamingReasoning) {
			const msg: ChatMessage = {
				id: `a-${Date.now()}`,
				role: 'assistant',
				content: this.view.view.streamingContent,
				reasoning: this.view.view.streamingReasoning || undefined,
				timestamp: Date.now(),
			};
			this.view.view.messages.push(msg);
		}

		// Clean up incremental render timer and do final full render
		if (this.view.view.fullRenderTimer) {
			window.clearTimeout(this.view.view.fullRenderTimer);
			this.view.view.fullRenderTimer = null;
		}
		if (this.view.view.streamingBodyEl && this.view.view.streamingContent) {
			this.view.view.streamingBodyEl.empty();
			void renderMarkdownSafe(this.view.app, this.view.view.streamingContent, this.view.view.streamingBodyEl, this.view.view.streamingComponent ?? this.view.view);
		} else if (this.view.view.streamingBodyEl && !this.view.view.streamingContent && !this.view.view.streamingReasoning) {
			// No text was streamed — show a subtle fallback
			this.view.view.streamingBodyEl.empty();
			this.view.view.streamingBodyEl.createDiv({
				cls: 'synapse-thinking synapse-cancelled',
				text: 'No response',
			});
		}
		this.view.view.lastFullRenderLen = 0;

		// Render metadata footer
		this.renderMessageMetadata();

		// Freeze the task panel's elapsed label at its final value, then stop live-tracking it —
		// the DOM itself is left in place (part of the finalized message).
		this.updateTaskPanelElapsed();
		this.clearTaskPanelState();

		this.view.view.streamingContent = '';
		this.view.view.streamingBodyEl = null;
		this.view.view.streamingWrapperEl = null;
		this.view.view.toolCallsContainer = null;
		this.view.view.activeToolCalls.clear();

		this.clearReasoningState();

		if (this.view.view.streamingComponent) {
			this.view.view.removeChild(this.view.view.streamingComponent);
			this.view.view.streamingComponent = null;
		}

		// Reset turn metadata
		this.view.view.turnStartTime = 0;
		this.view.view.turnToolsUsed = [];
		this.view.view.turnUsage = null;

		this.view.view.isStreaming = false;
		this.updateSendButton();

		// Update local session timestamp instead of full SDK round-trip
		if (this.view.view.currentSessionId) {
			const entry = this.view.view.sessionList.find(s => s.sessionId === this.view.view.currentSessionId);
			if (entry) {
				entry.lastModified = Date.now();
			}
		}
		this.view.view.renderSessionList();
	}

	private renderMessageMetadata(): void {
		if (!this.view.view.streamingWrapperEl) return;

		const hasTime = this.view.view.turnStartTime > 0;
		const hasTokens = this.view.view.turnUsage !== null;
		const uniqueTools = [...new Set(this.view.view.turnToolsUsed)];
		const hasTools = uniqueTools.length > 0;

		if (!hasTime && !hasTokens && !hasTools) return;

		const footer = this.view.view.streamingWrapperEl.createDiv({cls: 'synapse-msg-metadata'});

		// Elapsed time
		if (hasTime) {
			const elapsed = Date.now() - this.view.view.turnStartTime;
			const timeText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
			const timeSpan = footer.createSpan({cls: 'synapse-metadata-item'});
			const timeIcon = timeSpan.createSpan({cls: 'synapse-metadata-icon'});
			setIcon(timeIcon, 'clock');
			timeSpan.appendText(timeText);
		}

		// Token usage — show rounded total, detail on hover
		if (hasTokens) {
			const u = this.view.view.turnUsage!;
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
	}

	addToolCallBlock(toolCallId: string, toolName: string, args?: unknown): void {
		if (!this.view.view.toolCallsContainer) return;

		const details = this.view.view.toolCallsContainer.createEl('details', {cls: 'synapse-tool-call'});
		const summary = details.createEl('summary', {cls: 'synapse-tool-call-summary is-live'});
		summary.createSpan({cls: 'synapse-tool-call-name', text: toolName});
		const argSummary = formatToolArgsSummary(args);
		if (argSummary) {
			summary.createSpan({cls: 'synapse-tool-call-arg', text: argSummary});
		}
		summary.createSpan({cls: 'synapse-tool-call-time', text: '···'});

		// Input section
		if (args && typeof args === 'object' && Object.keys(args).length > 0) {
			const inputSection = details.createDiv({cls: 'synapse-tool-call-section'});
			inputSection.createDiv({cls: 'synapse-tool-call-label synapse-label-base', text: 'Input'});
			const pre = inputSection.createEl('pre', {cls: 'synapse-tool-call-code'});
			pre.createEl('code', {text: JSON.stringify(args, null, 2)});
		}

		const startTime = Date.now();
		this.view.view.activeToolCalls.set(toolCallId, {toolName, detailsEl: details, startTime});

		// Show "Processing ..." animation while tools are running
		this.showProcessingIndicator();

		this.view.scrollToBottom();
	}

	completeToolCallBlock(toolCallId: string, success: boolean, result?: {content?: string; detailedContent?: string}, error?: {message: string}): void {
		const entry = this.view.view.activeToolCalls.get(toolCallId);
		if (!entry) return;

		const {detailsEl, startTime} = entry;

		const summaryEl = detailsEl.querySelector<HTMLElement>('.synapse-tool-call-summary');
		if (summaryEl) {
			summaryEl.removeClass('is-live');
			const timeEl = summaryEl.querySelector<HTMLElement>('.synapse-tool-call-time');
			if (timeEl) {
				const elapsed = startTime ? Date.now() - startTime : 0;
				const timeText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
				if (success) {
					timeEl.setText(timeText);
				} else {
					timeEl.setText(timeText ? `${timeText} (err)` : 'err');
					timeEl.addClass('is-error');
				}
			}
		}

		// Output section
		const output = error ? `Error: ${error.message}` : (result?.detailedContent || result?.content || '');
		if (output) {
			const outputSection = detailsEl.createDiv({cls: 'synapse-tool-call-section'});
			outputSection.createDiv({cls: 'synapse-tool-call-label synapse-label-base', text: success ? 'Output' : 'Error'});
			const pre = outputSection.createEl('pre', {cls: 'synapse-tool-call-code'});
			const displayText = output.length > MAX_DEBUG_DISPLAY_LEN ? output.slice(0, MAX_DEBUG_DISPLAY_LEN) + '\n… (truncated)' : output;
			pre.createEl('code', {text: displayText});
		}

		this.view.view.activeToolCalls.delete(toolCallId);
		this.view.scrollToBottom();
	}

	// ── Task/plan tracking (TodoWrite #210) ────────────────────

	/**
	 * Render (or replace) the live task-tracking panel for the current turn. Each `TodoWrite`
	 * call is the *current* full plan state, so this always rebuilds the panel from scratch
	 * rather than appending — there is exactly one live panel per turn.
	 */
	renderTaskPanel(todos: TodoItem[]): void {
		if (!this.view.view.toolCallsContainer) return;

		let wasOpen = true;
		if (!this.view.view.taskPanelEl || !this.view.view.taskPanelEl.isConnected) {
			this.view.view.taskPanelEl = this.view.view.toolCallsContainer.createEl('details', {cls: 'synapse-task-panel synapse-findings'});
			(this.view.view.taskPanelEl as HTMLDetailsElement).open = true;
			// Keep the panel first among tool blocks — the plan is the headline, tool calls are detail.
			this.view.view.toolCallsContainer.prepend(this.view.view.taskPanelEl);
		} else {
			wasOpen = (this.view.view.taskPanelEl as HTMLDetailsElement).open ?? true;
		}
		this.view.view.currentTodos = todos;

		const panel = this.view.view.taskPanelEl as HTMLDetailsElement;
		panel.empty();
		panel.open = wasOpen;

		const summary = panel.createEl('summary', {cls: 'synapse-task-panel-header'});
		summary.createSpan({cls: 'synapse-task-panel-title synapse-label-base', text: 'PLAN'});
		const elapsedSpan = summary.createSpan({cls: 'synapse-task-panel-elapsed'});
		elapsedSpan.setAttribute('data-synapse-task-elapsed', 'true');

		const list = panel.createDiv({cls: 'synapse-task-list'});
		for (const todo of todos) {
			const item = list.createDiv({cls: `synapse-task-item synapse-finding is-${todo.status}`});
			const statusEl = item.createSpan({cls: 'synapse-task-item-status synapse-finding-key synapse-label-base'});
			if (todo.status === 'in_progress') {
				statusEl.createSpan({cls: 'synapse-task-active-dot'});
			}
			statusEl.appendText(TASK_STATUS_LABEL[todo.status] ?? todo.status.toUpperCase());

			const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
			item.createSpan({cls: 'synapse-task-item-label synapse-finding-val', text: label});
		}

		this.updateTaskPanelElapsed();
		if (!this.view.view.taskPanelTimer) {
			const timerId = window.setInterval(() => this.updateTaskPanelElapsed(), 1000);
			this.view.view.taskPanelTimer = timerId as unknown as ReturnType<typeof setInterval>;
			this.view.view.registerInterval(timerId);
		}

		this.view.scrollToBottom();
	}

	/** Refresh the live elapsed-runtime label in the current task panel, if any is shown. */
	private updateTaskPanelElapsed(): void {
		if (!this.view.view.taskPanelEl || !this.view.view.taskPanelEl.isConnected || this.view.view.turnStartTime === 0) return;
		const elapsedSpan = this.view.view.taskPanelEl.querySelector('[data-synapse-task-elapsed]');
		if (!elapsedSpan) return;
		const elapsed = Date.now() - this.view.view.turnStartTime;
		const timeText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
		elapsedSpan.textContent = timeText;
	}

	/** Reset task-panel state (called on turn finalize, new conversation, and session switches). */
	clearTaskPanelState(): void {
		if (this.view.view.taskPanelTimer) {
			window.clearInterval(this.view.view.taskPanelTimer as unknown as number);
			this.view.view.taskPanelTimer = null;
		}
		this.view.view.taskPanelEl = null;
		this.view.view.currentTodos = null;
		this.view.view.taskPlan.clear();
		this.view.view.pendingTaskCreates.clear();
	}

	// ── Compaction debug blocks ─────────────────────────────────

	addCompactionCompleteBlock(data: {tokensRemoved?: number; preCompactionTokens?: number; postCompactionTokens?: number; durationMs?: number; trigger?: string}): void {
		if (!this.view.view.toolCallsContainer) return;

		const details = this.view.view.toolCallsContainer.createEl('details', {cls: 'synapse-compaction-block'});
		const summary = details.createEl('summary', {cls: 'synapse-compaction-summary synapse-label-base'});
		const iconEl = summary.createSpan({cls: 'synapse-compaction-icon'});
		setIcon(iconEl, 'archive');
		summary.createSpan({text: 'Compaction complete'});
		const statusEl = summary.createSpan({cls: 'synapse-tool-call-status is-success'});
		setIcon(statusEl, 'check');

		const body = details.createDiv({cls: 'synapse-compaction-body'});
		const lines: string[] = [];
		if (data.preCompactionTokens != null) lines.push(`Pre-compaction tokens: ${data.preCompactionTokens.toLocaleString()}`);
		if (data.postCompactionTokens != null) lines.push(`Post-compaction tokens: ${data.postCompactionTokens.toLocaleString()}`);
		const tokensRemoved = data.tokensRemoved ?? (data.preCompactionTokens != null && data.postCompactionTokens != null ? data.preCompactionTokens - data.postCompactionTokens : undefined);
		if (tokensRemoved != null) lines.push(`Tokens removed: ${tokensRemoved.toLocaleString()}`);
		if (data.durationMs != null) lines.push(`Duration: ${(data.durationMs / 1000).toFixed(1)}s`);
		if (data.trigger != null) lines.push(`Trigger: ${data.trigger}`);
		if (lines.length > 0) {
			const pre = body.createEl('pre', {cls: 'synapse-tool-call-code'});
			pre.createEl('code', {text: lines.join('\n')});
		}

		this.view.scrollToBottom();
	}

	renderWelcome(): void {
		const welcome = this.view.chatContainer.createDiv({cls: 'synapse-welcome'});
		const icon = welcome.createDiv({cls: 'synapse-welcome-icon'});
		setIcon(icon, SYNAPSE_ICON_ID);
		welcome.createEl('h3', {text: 'Synapse'});
		welcome.createEl('p', {
			text: 'Your AI-powered second brain. Select an agent, choose a model, configure tools and get the job done!',
			cls: 'synapse-welcome-desc',
		});
	}

	updateSendButton(): void {
		this.view.view.sendBtn.empty();
		if (this.view.view.isStreaming) {
			setIcon(this.view.view.sendBtn, 'square');
			this.view.view.sendBtn.title = 'Stop';
			this.view.view.sendBtn.addClass('is-streaming');
		} else {
			setIcon(this.view.view.sendBtn, 'arrow-up');
			this.view.view.sendBtn.title = 'Send message';
			this.view.view.sendBtn.removeClass('is-streaming');
		}
	}
}