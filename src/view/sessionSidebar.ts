import {Menu, Modal, Notice, setIcon} from 'obsidian';
import type {SessionMetadata, SessionMessage} from '../agentService';
import type {ChatMessage} from '../types';
import {debugTrace} from '../debug';
import {formatTimeAgo, stripSessionTypePrefix, stripInjectedPromptContext} from './utils';
import type {ViewContext} from './types';
import {BackgroundSession} from './backgroundSession';

/** A single content block from an Anthropic API message (subset used for replay). */
type AnthropicContentBlock = {
	type: string;
	text?: string;
	thinking?: string;
};

/** Shape of `SessionMessage.message` — an Anthropic API message body. */
type AnthropicMessageBody = {
	content?: string | AnthropicContentBlock[];
};

/**
 * Detect transcript text that is entirely a synthetic wrapper (system-reminder
 * injection, slash-command wrapper, local-command output) rather than genuine
 * user-typed content. `getSessionMessages()` exposes no meta flag to filter on
 * (`SessionMessage` only carries `{type, uuid, session_id, message,
 * parent_tool_use_id}`), so this is a defensive string check as a safety net —
 * verified against real multi-turn Synapse session transcripts (including
 * tool-using ones) where every text-bearing `user` entry was a genuine prompt.
 */
function isSyntheticWrapperText(text: string): boolean {
	const trimmed = text.trim();
	return /^<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/.test(trimmed);
}

/**
 * Extract plain text from a transcript message's `content`, which may be a
 * plain string (simple prompts) or an array of content blocks. Non-text
 * blocks (images, tool_use, tool_result — replay of those is out of scope)
 * are skipped.
 */
function extractMessageText(message: unknown): string {
	const body = message as AnthropicMessageBody | undefined;
	if (!body || typeof body !== 'object') return '';
	if (typeof body.content === 'string') return body.content;
	if (Array.isArray(body.content)) {
		return body.content
			.filter(block => block.type === 'text' && typeof block.text === 'string')
			.map(block => block.text as string)
			.join('');
	}
	return '';
}

/**
 * Extract text and thinking content from an assistant transcript message.
 * `tool_use` blocks are skipped — tool-call replay is out of scope.
 */
function extractAssistantContent(message: unknown): {text: string; thinking: string} {
	const text = extractMessageText(message);
	const body = message as AnthropicMessageBody | undefined;
	const thinking = body && typeof body === 'object' && Array.isArray(body.content)
		? body.content
			.filter(block => block.type === 'thinking' && typeof block.thinking === 'string')
			.map(block => block.thinking as string)
			.join('')
		: '';
	return {text, thinking};
}

/**
 * Session-sidebar controller (composition refactor — formerly prototype injection into
 * `SynapseView`, `.docs/research/2026-09-11-view-composition-refactor.md`). Owns the
 * sidebar DOM it builds (header buttons, search input, session list) and the
 * sidebar-local UI state (`sessionFilter`, `sessionTypeFilter`, `sessionSort`,
 * `sidebarWidth`), plus the background-save/restore lifecycle for chat sessions.
 *
 * The chat-session state those methods read and write — `activeSessions`,
 * `sessionList`, `sessionNames`, `currentSession`/`currentSessionId`, the
 * streaming-lifecycle fields, and the task-plan maps — stays on `SynapseView` for now
 * (the streaming-lifecycle state migration to the renderer is a later, separate step)
 * and is reached through its `ViewContext` as `this.view.view.<x>`.
 */
export class SessionSidebarController {
	// ── Sidebar DOM refs (moved from SynapseView) ────────────────
	private sidebarEl!: HTMLElement;
	private sidebarListEl!: HTMLElement;
	private sidebarSearchEl!: HTMLInputElement;
	private sidebarFilterEl!: HTMLButtonElement;
	private sidebarSortEl!: HTMLButtonElement;
	private sidebarRefreshEl!: HTMLButtonElement;
	private sidebarDeleteEl!: HTMLButtonElement;

	// ── Sidebar state (moved from SynapseView) ───────────────────
	/** Collapsed-vs-expanded width in px; CSS consumes it via `--sidebar-width`. */
	private sidebarWidth = 40;
	private sessionFilter = '';
	private sessionTypeFilter = new Set<'chat' | 'inline' | 'search' | 'other'>(['chat']);
	private sessionSort: 'modified' | 'created' | 'name' = 'modified';
	/** Monotonically increasing token to guard against overlapping session selections / stale restores. */
	private selectionToken = 0;

	constructor(private view: ViewContext) {}

	/** Invalidate any in-flight session selection or restore (e.g. when starting a new conversation). */
	cancelInFlightSelection(): void {
		this.selectionToken++;
	}

	// ── View-owned state accessors ───────────────────────────────
	// Accessors (not copied fields) so the historical `this.<name>` spellings in the
	// methods below keep compiling against state that still lives on `SynapseView`.
	// `messages` in particular must keep its `this.messages.length` spelling —
	// test/editorialSidebarSearch.test.ts asserts that exact substring.
	private get messages(): ChatMessage[] {
		return this.view.view.messages;
	}

	private set messages(value: ChatMessage[]) {
		this.view.view.messages = value;
	}

	/** Build the sidebar (header buttons, search, session list) into `parent`. */
	build(parent: HTMLElement): void {
		this.sidebarEl = parent.createDiv({cls: 'synapse-sidebar'});
		this.sidebarEl.setCssProps({'--sidebar-width': `${this.sidebarWidth}px`});

		// Header: new session button + filter + sort + search
		const header = this.sidebarEl.createDiv({cls: 'synapse-sidebar-header'});

		const headerBtnRow = header.createDiv({cls: 'synapse-sidebar-btn-row'});

		const newBtn = headerBtnRow.createEl('button', {
			cls: 'clickable-icon synapse-icon-btn synapse-sidebar-new-btn',
			attr: {title: 'New session'},
		});
		setIcon(newBtn, 'plus');
		newBtn.addEventListener('click', () => void this.view.view.newConversation());

		this.sidebarFilterEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon synapse-sidebar-filter-btn',
			attr: {title: 'Filter sessions by type'},
		});
		setIcon(this.sidebarFilterEl, 'filter');
		this.sidebarFilterEl.addEventListener('click', (e) => this.openSessionFilterMenu(e));
		this.updateFilterBadge();

		this.sidebarSortEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon synapse-sidebar-sort-btn',
			attr: {title: 'Sort sessions'},
		});
		setIcon(this.sidebarSortEl, 'arrow-up-down');
		this.sidebarSortEl.addEventListener('click', (e) => this.openSessionSortMenu(e));
		this.updateSortBadge();

		this.sidebarRefreshEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon synapse-sidebar-refresh-btn',
			attr: {title: 'Refresh sessions'},
		});
		setIcon(this.sidebarRefreshEl, 'refresh-cw');
		this.sidebarRefreshEl.addEventListener('click', () => {
			void this.loadSessions();
			void this.view.view.loadAllConfigs();
		});

		this.sidebarDeleteEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon synapse-sidebar-delete-btn',
			attr: {title: 'Delete displayed sessions'},
		});
		setIcon(this.sidebarDeleteEl, 'trash-2');
		this.sidebarDeleteEl.addEventListener('click', () => this.confirmDeleteDisplayedSessions());

		this.sidebarSearchEl = header.createEl('input', {
			type: 'text',
			placeholder: 'Search…',
			cls: 'synapse-sidebar-search',
		});
		this.sidebarSearchEl.addEventListener('input', () => {
			this.sessionFilter = this.sidebarSearchEl.value.toLowerCase();
			this.renderSessionList();
		});

		// Session list (scrollable)
		this.sidebarListEl = this.sidebarEl.createDiv({cls: 'synapse-sidebar-list'});
	}

	initSplitter(): void {
		let startX = 0;
		let startWidth = 0;
		let dragging = false;

		const onMouseMove = (e: MouseEvent) => {
			if (!dragging) return;
			// Sidebar is on the right, so dragging left increases width
			const dx = startX - e.clientX;
			const newWidth = Math.max(40, Math.min(300, startWidth + dx));
			this.sidebarWidth = newWidth;
			this.sidebarEl.setCssProps({'--sidebar-width': `${newWidth}px`});
		};

		const onMouseUp = () => {
			dragging = false;
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			this.view.view.splitterEl.removeClass('is-dragging');
			document.body.removeClass('synapse-no-select');
			// Re-render session list once on drag end instead of every mousemove
			this.renderSessionList();
		};

		this.view.view.splitterEl.addEventListener('mousedown', (e) => {
			e.preventDefault();
			dragging = true;
			startX = e.clientX;
			startWidth = this.sidebarWidth;
			this.view.view.splitterEl.addClass('is-dragging');
			document.body.addClass('synapse-no-select');
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
		});

		this.view.view.register(() => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		});
	}

	async loadSessions(): Promise<void> {
		if (!this.view.plugin.agentService) return;
		try {
			this.view.view.sessionList = await this.view.plugin.agentService.listSessions();
			this.sortSessionList();
			this.renderSessionList();
		} catch {
			// silently ignore — session list stays as-is
		}
	}

	private sortSessionList(): void {
		switch (this.sessionSort) {
			case 'modified':
				this.view.view.sessionList.sort((a, b) => {
					const ta = a.lastModified;
					const tb = b.lastModified;
					return tb - ta;
				});
				break;
			case 'created':
				this.view.view.sessionList.sort((a, b) => {
					// `createdAt` is set-once from the transcript's first entry's timestamp
					// (SDK `SDKSessionInfo.createdAt?`); older sessions may not carry it, so
					// fall back to `lastModified` — this case was previously a byte-identical
					// copy of the `modified` sort (audit §6, issue #236), i.e. a dead branch.
					const ta = a.createdAt ?? a.lastModified;
					const tb = b.createdAt ?? b.lastModified;
					return tb - ta;
				});
				break;
			case 'name':
				this.view.view.sessionList.sort((a, b) => {
					const na = this.getSessionDisplayName(a).toLowerCase();
					const nb = this.getSessionDisplayName(b).toLowerCase();
					return na.localeCompare(nb);
				});
				break;
		}
	}

	renderSessionList(): void {
		if (!this.sidebarListEl) return;
		this.sidebarListEl.empty();

		const isExpanded = this.sidebarWidth > 80;
		// Show/hide search and filter/sort/refresh when collapsed
		if (this.sidebarSearchEl) {
			this.sidebarSearchEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarFilterEl) {
			this.sidebarFilterEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarSortEl) {
			this.sidebarSortEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarRefreshEl) {
			this.sidebarRefreshEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarDeleteEl) {
			this.sidebarDeleteEl.toggleClass('is-hidden', !isExpanded);
		}

		const displayedSessions = this.getDisplayedSessions();
		if (displayedSessions.length === 0) {
			if (isExpanded) {
				this.sidebarListEl.createDiv({
					cls: 'synapse-sidebar-empty',
					text: this.sessionFilter ? 'No matching sessions' : 'No sessions yet',
				});
			}
			return;
		}

		// Partition into active background sessions and regular/recent sessions
		const bgSessions = displayedSessions.filter(s => this.view.view.activeSessions.has(s.sessionId) && s.sessionId !== this.view.view.currentSessionId);
		const otherSessions = displayedSessions.filter(s => !this.view.view.activeSessions.has(s.sessionId) || s.sessionId === this.view.view.currentSessionId);

		if (bgSessions.length > 0) {
			if (isExpanded) {
				this.sidebarListEl.createDiv({cls: 'synapse-sidebar-heading synapse-label-base', text: 'Background'});
			}
			for (const session of bgSessions) {
				this.renderSessionItem(this.sidebarListEl, session, {
					expanded: isExpanded,
					onClick: () => void this.selectSession(session.sessionId),
					onContextMenu: (e) => this.showSessionContextMenu(e, session.sessionId),
				});
			}
			if (isExpanded && otherSessions.length > 0) {
				this.sidebarListEl.createDiv({cls: 'synapse-sidebar-heading synapse-label-base', text: 'Sessions'});
			}
			for (const session of otherSessions) {
				this.renderSessionItem(this.sidebarListEl, session, {
					expanded: isExpanded,
					onClick: () => void this.selectSession(session.sessionId),
					onContextMenu: (e) => this.showSessionContextMenu(e, session.sessionId),
				});
			}
		} else {
			if (isExpanded) {
				this.sidebarListEl.createDiv({cls: 'synapse-sidebar-heading synapse-label-base', text: 'Sessions'});
			}
			for (const session of displayedSessions) {
				this.renderSessionItem(this.sidebarListEl, session, {
					expanded: isExpanded,
					onClick: () => void this.selectSession(session.sessionId),
					onContextMenu: (e) => this.showSessionContextMenu(e, session.sessionId),
				});
			}
		}
	}

	private renderSessionItem(container: HTMLElement, session: SessionMetadata, opts: {
		expanded?: boolean;
		onClick: () => void;
		onContextMenu: (e: MouseEvent) => void;
	}): void {
		const expanded = opts.expanded ?? true;
		const item = container.createDiv({cls: 'synapse-session-item'});
		const isActive = session.sessionId === this.view.view.currentSessionId;
		if (isActive) item.addClass('is-active');

		const sessionType = this.getSessionType(session);
		const iconName = sessionType === 'chat' ? 'message-square' : sessionType === 'inline' ? 'file-text' : sessionType === 'search' ? 'search' : 'code';
		const iconEl = item.createSpan({cls: 'synapse-session-icon'});
		setIcon(iconEl, iconName);

		// Green active dot when processing (current or background session)
		const isCurrentStreaming = isActive && this.view.view.isStreaming;
		const bgSession = this.view.view.activeSessions.get(session.sessionId);
		const isBgStreaming = bgSession?.isStreaming ?? false;
		if (isCurrentStreaming || isBgStreaming) {
			iconEl.createSpan({cls: 'synapse-session-active-dot'});
		}

		const name = this.getSessionDisplayName(session);
		if (expanded) {
			const details = item.createDiv({cls: 'synapse-session-details'});
			details.createDiv({cls: 'synapse-session-name', text: name});
			const modTime = new Date(session.lastModified);
			const rawCount = (session.sessionId === this.view.view.currentSessionId ? this.messages.length : undefined)
				?? this.view.view.activeSessions.get(session.sessionId)?.messages.length;
			const timeAgo = formatTimeAgo(modTime);
			const metaText = rawCount !== undefined && rawCount > 0
				? `${timeAgo} · ${rawCount} msg${rawCount === 1 ? '' : 's'}`
				: timeAgo;
			details.createDiv({cls: 'synapse-session-time', text: metaText});

			const actions = item.createDiv({cls: 'synapse-session-actions'});
			const renameBtn = actions.createEl('button', {
				cls: 'clickable-icon synapse-session-action-btn',
				attr: {title: 'Rename session', 'aria-label': 'Rename session'},
			});
			setIcon(renameBtn, 'pencil');
			renameBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.renameSession(session.sessionId);
			});

			const deleteBtn = actions.createEl('button', {
				cls: 'clickable-icon synapse-session-action-btn mod-delete',
				attr: {title: 'Delete session', 'aria-label': 'Delete session'},
			});
			setIcon(deleteBtn, 'trash-2');
			deleteBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.confirmDeleteSession(session.sessionId);
			});
		}

		item.setAttribute('title', name);
		item.setAttribute('tabindex', '0');
		item.setAttribute('role', 'button');
		item.setAttribute('aria-label', name);
		item.addEventListener('click', opts.onClick);
		item.addEventListener('contextmenu', opts.onContextMenu);
		item.addEventListener('keydown', (ke: KeyboardEvent) => {
			if (ke.key === 'Enter' || ke.key === ' ') {
				ke.preventDefault();
				opts.onClick();
			} else if (ke.key === 'F2') {
				ke.preventDefault();
				this.renameSession(session.sessionId);
			} else if (ke.key === 'Delete') {
				ke.preventDefault();
				this.confirmDeleteSession(session.sessionId);
			}
		});
	}

	getSessionDisplayName(session: SessionMetadata): string {
		const raw = this.view.view.sessionNames[session.sessionId]
			|| session.summary
			|| `Session ${session.sessionId.slice(0, 8)}`;
		// Strip session type prefix for display
		return stripSessionTypePrefix(raw);
	}

	private getSessionType(session: SessionMetadata): 'chat' | 'inline' | 'search' | 'other' {
		const name = this.view.view.sessionNames[session.sessionId] || '';
		debugTrace(`Synapse: getSessionType id=${session.sessionId.slice(0, 8)} name="${name.slice(0, 40)}"`);
		if (name.startsWith('[chat]')) return 'chat';
		if (name.startsWith('[inline]')) return 'inline';
		if (name.startsWith('[search]')) return 'search';
		return 'other';
	}

	private openSessionFilterMenu(e: MouseEvent): void {
		const menu = new Menu();
		const types: Array<{value: 'chat' | 'inline' | 'search' | 'other'; label: string}> = [
			{value: 'chat', label: 'Chat'},
			{value: 'search', label: 'Search'},
			{value: 'inline', label: 'Inline'},
			{value: 'other', label: 'Other'},
		];
		for (const {value, label} of types) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionTypeFilter.has(value))
					.onClick(() => {
						if (this.sessionTypeFilter.has(value)) {
							this.sessionTypeFilter.delete(value);
						} else {
							this.sessionTypeFilter.add(value);
						}
						this.updateFilterBadge();
						this.renderSessionList();
					});
			});
		}
		menu.addSeparator();
		menu.addItem(item => {
			item.setTitle('Show all')
				.onClick(() => {
					this.sessionTypeFilter.clear();
					this.updateFilterBadge();
					this.renderSessionList();
				});
		});
		menu.showAtMouseEvent(e);
	}

	private updateFilterBadge(): void {
		// When no types selected (show all), dim the icon; otherwise mark active
		const hasFilter = this.sessionTypeFilter.size > 0;
		this.sidebarFilterEl.toggleClass('is-active', hasFilter);
		this.sidebarFilterEl.setAttribute('title',
			hasFilter
				? `Filter: ${[...this.sessionTypeFilter].join(', ')}`
				: 'Filter sessions (showing all)');
	}

	private openSessionSortMenu(e: MouseEvent): void {
		const menu = new Menu();
		const sorts: Array<{value: 'modified' | 'created' | 'name'; label: string}> = [
			{value: 'modified', label: 'Modified date'},
			{value: 'created', label: 'Created date'},
			{value: 'name', label: 'Name'},
		];
		for (const {value, label} of sorts) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionSort === value)
					.onClick(() => {
						this.sessionSort = value;
						this.updateSortBadge();
						this.sortSessionList();
						this.renderSessionList();
					});
			});
		}
		menu.showAtMouseEvent(e);
	}

	private updateSortBadge(): void {
		const labels: Record<string, string> = {modified: 'Modified', created: 'Created', name: 'Name'};
		this.sidebarSortEl.setAttribute('title', `Sort: ${labels[this.sessionSort]}`);
	}

	saveCurrentToBackground(): void {
		if (!this.view.view.currentSession || !this.view.view.currentSessionId) return;

		// Evict the oldest idle background session if at capacity
		const MAX_BACKGROUND_SESSIONS = 8;
		if (this.view.view.activeSessions.size >= MAX_BACKGROUND_SESSIONS) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [key, bg] of this.view.view.activeSessions) {
				if (bg.isStreaming) continue; // don't evict active streams
				const entry = this.view.view.sessionList.find(s => s.sessionId === key);
				const t = entry?.lastModified ?? 0;
				if (t < oldestTime) {
					oldestTime = t;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				const evicted = this.view.view.activeSessions.get(oldestKey);
				if (evicted) {
					evicted.detach();
					try { void evicted.session.disconnect(); } catch { /* ignore */ }
					this.view.view.activeSessions.delete(oldestKey);
				}
			}
		}

		// Detach events from foreground routing
		this.view.view.unsubscribeEvents();

		// No more DOM-fragment handoff (audit §4, issue #237): the container is simply
		// cleared here, and `restoreFromBackground()` reconstructs the DOM by re-rendering
		// from the model's plain-data state instead of resurrecting saved live DOM nodes.
		this.view.chatContainer.empty();

		const bg = new BackgroundSession({
			sessionId: this.view.view.currentSessionId,
			session: this.view.view.currentSession,
			messages: [...this.messages],
			sessionToolGrants: new Set(this.view.view.sessionToolGrants),
			isStreaming: this.view.view.isStreaming,
			streamingContent: this.view.view.streamingContent,
			streamingReasoning: this.view.view.streamingReasoning,
			reasoningComplete: this.view.view.reasoningComplete,
			turnStartTime: this.view.view.turnStartTime,
			turnToolsUsed: [...this.view.view.turnToolsUsed],
			turnUsage: this.view.view.turnUsage ? {...this.view.view.turnUsage} : null,
		});
		bg.taskPlanTracker.restore(this.view.view.taskPlanTracker.snapshot());

		// If still streaming, attach background event routing
		if (bg.isStreaming) {
			bg.attach({
				onIdle: () => {
					// Re-render sidebar to remove the green dot
					this.renderSessionList();
					void this.loadSessions();
				},
				onError: () => {
					this.renderSessionList();
				},
				onRunResult: (cumulativeCostUsd) => {
					this.view.view.saveSessionCostBaseline(bg.sessionId, cumulativeCostUsd);
				},
			});
		}

		this.view.view.activeSessions.set(this.view.view.currentSessionId, bg);

		if (this.view.view.fullRenderTimer) {
			window.clearTimeout(this.view.view.fullRenderTimer);
			this.view.view.fullRenderTimer = null;
		}
		this.view.view.lastFullRenderLen = 0;
		this.view.view.renderer.clearReasoningState();
		// The task panel's DOM no longer travels with a saved fragment — it was discarded
		// with the container above; just stop this view's live-elapsed timer for it.
		this.view.view.renderer.clearTaskPanelState();

		// Release the streaming component and its DOM — the background model owns none of
		// this; restoring re-renders it fresh from `bg.streamingContent`/`bg.streamingReasoning`.
		if (this.view.view.streamingComponent) {
			this.view.view.removeChild(this.view.view.streamingComponent);
			this.view.view.streamingComponent = null;
		}
		this.view.view.streamingBodyEl = null;
		this.view.view.streamingWrapperEl = null;
		this.view.view.toolCallsContainer = null;
		this.view.view.activeToolCalls.clear();

		this.view.view.currentSession = null;
		this.view.view.currentSessionId = null;
	}

	async restoreFromBackground(bg: BackgroundSession, token = this.selectionToken): Promise<void> {
		// **No listener-gap window.** `bg` stays attached (still routing SDK events into its
		// own model) through every `await` below until the exact synchronous point where we
		// flip ownership: `bg.detach()` immediately followed, with no intervening `await`, by
		// copying `bg`'s *then-current* fields onto the view and calling
		// `registerSessionEvents()`. Reviewer finding (HIGH): an earlier version detached `bg`
		// first and only registered foreground handlers after awaiting the history render —
		// any `session.idle`/`tool.*`/delta event that arrived in that window had no listener
		// at all and was silently dropped. Two consequences of keeping `bg` attached during the
		// renders:
		//   1. History rendering below must snapshot `bg.messages` up front (it's still being
		//      pushed to by a live `session.idle`/`session.error` handler) and, after the
		//      render awaits, render any messages that landed while we were awaiting — a
		//      `while` loop re-reading `bg.messages.length` handles any number of them.
		//   2. Every other field read to populate the view (`isStreaming`, `streamingContent`,
		//      `turnUsage`, the task-plan tracker snapshot, …) is read in the single synchronous
		//      block right after `bg.detach()`, not before the history-render awaits, so it
		//      reflects whatever `bg` last observed, not a stale pre-render snapshot.
		//
		// **Selection token guard against concurrent session selections.** If the user selects
		// another session (or starts a new conversation) while the renders below are in flight,
		// `token` becomes stale (`this.selectionToken !== token`). We check freshness before
		// and between async renders and immediately before adopting background state. If stale,
		// we return early without detaching `bg` or touching foreground state, ensuring `bg`
		// remains safely attached in `activeSessions` with zero lost events.
		this.view.chatContainer.empty();

		const historySnapshot = bg.messages.slice();
		const renderPromises: Promise<void>[] = [];
		for (const msg of historySnapshot) {
			renderPromises.push(this.view.view.renderer.renderMessageBubble(msg));
		}
		await Promise.all(renderPromises);

		if (this.selectionToken !== token) return;

		// Render any message(s) `bg`'s still-attached handlers pushed (e.g. a `session.idle`
		// finalize) while the history above was rendering — one at a time, re-checking the
		// live length each iteration, so a burst of idle→next-turn-idle while we awaited is
		// still fully rendered in order.
		let renderedCount = historySnapshot.length;
		while (renderedCount < bg.messages.length) {
			if (this.selectionToken !== token) return;
			const nextMsg = bg.messages[renderedCount];
			if (!nextMsg) break;
			await this.view.view.renderer.renderMessageBubble(nextMsg);
			renderedCount++;
		}

		if (this.selectionToken !== token) return;

		// ── Atomic ownership switch — no `await` between here and `registerSessionEvents()` ──
		bg.detach();
		this.view.view.activeSessions.delete(bg.sessionId);

		this.view.view.currentSession = bg.session;
		this.view.view.currentSessionId = bg.sessionId;
		this.messages = bg.messages;
		this.view.view.sessionToolGrants = bg.sessionToolGrants;
		this.view.view.isStreaming = bg.isStreaming;
		this.view.view.streamingContent = bg.streamingContent;
		this.view.view.streamingReasoning = bg.streamingReasoning;
		this.view.view.reasoningComplete = bg.reasoningComplete;
		this.view.view.turnStartTime = bg.turnStartTime;
		this.view.view.turnToolsUsed = bg.turnToolsUsed;
		this.view.view.turnUsage = bg.turnUsage;
		this.view.view.configDirty = false;
		this.view.view.lastFullRenderLen = 0;
		this.view.view.taskPlanTracker.restore(bg.taskPlanTracker.snapshot());

		this.view.view.streamingComponent = null;
		this.view.view.streamingBodyEl = null;
		this.view.view.streamingWrapperEl = null;
		this.view.view.toolCallsContainer = null;
		this.view.view.activeToolCalls.clear();
		this.view.view.renderer.clearReasoningState();
		this.view.view.renderer.clearTaskPanelState();

		// Re-attach foreground event routing — from this statement on, `handleSessionEvent()`
		// is the only listener for this `Session`, so nothing after this point can land in a
		// gap even though the rendering below still awaits.
		this.view.view.registerSessionEvents();
		// ── End of the atomic switch ──

		if (this.view.view.isStreaming) {
			// Turn still in progress — rebuild a live placeholder from the accumulated
			// streaming buffers. A tool-call block still `is-live` when the session went to
			// the background is not restorable in full visual detail here (see the class doc
			// on `BackgroundSession`) — only its plain-text/reasoning/task-plan effects survive.
			this.view.view.renderer.addAssistantPlaceholder();
			if (this.view.view.streamingReasoning) {
				this.view.view.renderer.syncReasoningContent(this.view.view.streamingReasoning);
				if (this.view.view.reasoningComplete) {
					this.view.view.renderer.finalizeReasoning();
				}
			}
			if (this.view.view.streamingContent) {
				await this.view.view.renderer.updateStreamingRender();
			}
			if (this.selectionToken !== token) return;
			const tracker = this.view.view.taskPlanTracker;
			const restoredTodos = tracker.hasPlan ? (tracker.taskPlan.size > 0 ? [...tracker.taskPlan.values()] : tracker.currentTodos) : null;
			if (restoredTodos) {
				this.view.view.renderer.renderTaskPanel(restoredTodos);
			}
		} else if (this.messages.length === 0) {
			this.view.view.renderer.renderWelcome();
		}

		if (this.selectionToken !== token) return;

		// Restored session carries whatever query-metadata cache (#130) it last captured
		// while backgrounded — reflect it (or its absence) immediately rather than waiting
		// for this session's next turn.
		this.view.view.configToolbar.updateContextIndicator();

		// Restore agent from session name
		this.restoreAgentFromSessionName(bg.sessionId);

		// Force scroll to end
		this.view.view.forceScrollToBottom();
		// restoreAgentFromSessionName() above may have changed selectedAgent, so refresh the
		// state line too, not just the kicker (#217).
		this.view.view.refreshComposerState();
	}

	private restoreAgentFromSessionName(sessionId: string): void {
		let sessionName = this.view.view.sessionNames[sessionId] || '';
		// Strip session type prefix
		sessionName = stripSessionTypePrefix(sessionName);
		const colonIdx = sessionName.indexOf(':');
		if (colonIdx > 0) {
			const agentName = sessionName.substring(0, colonIdx).trim();
			if (this.view.view.agents.some(a => a.name === agentName)) {
				this.view.view.configToolbar.selectAgent(agentName);
			}
		}
	}

	async selectSession(sessionId: string): Promise<void> {
		if (sessionId === this.view.view.currentSessionId && this.view.view.currentSession) return;

		const token = ++this.selectionToken;

		// ── Save current session to background (if streaming, keep it alive) ──
		if (this.view.view.currentSession && this.view.view.currentSessionId) {
			this.saveCurrentToBackground();
		}

		// Clear UI for the new session
		this.messages = [];
		// Reset in-memory tool-approval grants (#193 round 2) — a different session is a
		// different conversation with no known grants of its own, unless it's still alive in
		// the background, in which case restoreFromBackground() (below) overwrites this with
		// that session's own accumulated set.
		this.view.view.sessionToolGrants = new Set();
		if (this.view.view.fullRenderTimer) {
			window.clearTimeout(this.view.view.fullRenderTimer);
			this.view.view.fullRenderTimer = null;
		}
		this.view.view.streamingContent = '';
		this.view.view.lastFullRenderLen = 0;
		this.view.view.streamingBodyEl = null;
		this.view.view.streamingWrapperEl = null;
		this.view.view.toolCallsContainer = null;
		this.view.view.activeToolCalls.clear();
		this.view.view.renderer.clearReasoningState();
		if (this.view.view.streamingComponent) {
			this.view.view.removeChild(this.view.view.streamingComponent);
			this.view.view.streamingComponent = null;
		}
		this.view.view.isStreaming = false;
		this.view.chatContainer.empty();

		// ── Check if the target session is already alive in background ──
		const bg = this.view.view.activeSessions.get(sessionId);
		if (bg) {
			await this.restoreFromBackground(bg, token);
			if (this.selectionToken !== token) return;
			this.renderSessionList();
			this.view.view.renderer.updateSendButton();
			return;
		}

		// ── Otherwise, resume from SDK (cold load) ──

		try {
			// Build full session config so skills, MCP servers, etc. are available
			const agent = this.view.view.agents.find(a => a.name === this.view.view.selectedAgent);
			const sessionConfig = this.view.view.buildSessionConfig({
				model: this.view.view.selectedModel || undefined,
				selectedAgentName: this.view.view.selectedAgent || undefined,
				systemContent: agent?.instructions || undefined,
			});

			this.view.view.earlyEventBuffer = [];
			// Seed the cost-delta baseline from the persisted map (issue #269 AC-1): this is a
			// cold resume from a session on disk, not a live `Session` this process already
			// held, so there's no in-memory baseline to carry forward the way `ensureSession()`
			// does — but `saveSessionCostBaseline()` (called from the foreground
			// `assistant.run_result` handler on every run of every session, including a prior
			// visit to this same one) persists the last-seen cumulative total per session id, so
			// it's available here even across a plugin reload. `undefined` when this session has
			// never reported a result before (including a first-ever cold resume, or one whose
			// baseline aged out of the bounded map) — `createSession()` then behaves exactly as
			// before this fix: the first `assistant.run_result` reports the whole conversation's
			// cost on CLI >= 2.1.277.
			const initialCumulativeCostUsd = this.view.plugin.settings?.sessionCostBaselines?.[sessionId];
			const session = await this.view.plugin.agentService!.createSession({
				...sessionConfig,
				resume: sessionId,
			}, undefined, initialCumulativeCostUsd);

			if (this.selectionToken !== token) {
				try { void session.disconnect(); } catch { /* ignore */ }
				return;
			}

			// Load message history from the persisted transcript (cold load).
			const sessionMeta = this.view.view.sessionList.find(s => s.sessionId === sessionId);
			const fallbackTimestamp = sessionMeta?.createdAt ?? sessionMeta?.lastModified ?? Date.now();

			// Deliberately omit `dir`: sessions are listed across all project
			// directories (loadSessions() calls listSessions() unscoped), and the
			// working directory can change between when a session was created and
			// when it's cold-restored (autoUpdateWorkingDirectory). Passing a `dir`
			// that doesn't match the session's original project directory makes the
			// SDK search only that one directory and return `[]` — reproducing the
			// empty-chat bug this change fixes. Omitting `dir` searches all projects.
			let sessionMessages: SessionMessage[] = [];
			try {
				sessionMessages = await this.view.plugin.agentService!.getSessionMessages(sessionId);
			} catch (e) {
				console.warn('[synapse] Failed to read session transcript for replay:', e);
			}

			if (this.selectionToken !== token) {
				try { void session.disconnect(); } catch { /* ignore */ }
				return;
			}

			const renderPromises: Promise<void>[] = [];
			let pendingReasoning: string | undefined;
			for (const sm of sessionMessages) {
				// The declared SessionMessage type omits `timestamp`, but the runtime
				// object carries the ISO string from the transcript entry.
				const rawTimestamp = (sm as {timestamp?: string}).timestamp;
				const timestamp = rawTimestamp ? new Date(rawTimestamp).getTime() : fallbackTimestamp;

				if (sm.type === 'user') {
					let text = extractMessageText(sm.message);
					if (!text || isSyntheticWrapperText(text)) continue;
					text = stripInjectedPromptContext(text);
					if (!text) continue;
					const msg: ChatMessage = {
						id: sm.uuid,
						role: 'user',
						content: text,
						timestamp,
					};
					this.messages.push(msg);
					renderPromises.push(this.view.view.renderer.renderMessageBubble(msg));
					pendingReasoning = undefined;
				} else if (sm.type === 'assistant') {
					const {text, thinking} = extractAssistantContent(sm.message);
					if (thinking) pendingReasoning = thinking;
					if (!text) continue;
					const msg: ChatMessage = {
						id: sm.uuid,
						role: 'assistant',
						content: text,
						reasoning: pendingReasoning,
						timestamp,
					};
					this.messages.push(msg);
					renderPromises.push(this.view.view.renderer.renderMessageBubble(msg));
					pendingReasoning = undefined;
				}
				// 'system' messages (compact boundaries etc.) are not requested
				// (includeSystemMessages defaults to false) and are skipped if seen.
			}
			await Promise.all(renderPromises);

			if (this.selectionToken !== token) {
				try { void session.disconnect(); } catch { /* ignore */ }
				return;
			}

			if (this.messages.length === 0) {
				this.view.view.renderer.renderWelcome();
			}

			// Regular session — keep the handle active for interaction
			this.view.view.currentSession = session;
			this.view.view.currentSessionId = sessionId;
			this.view.view.configDirty = false;
			this.view.view.registerSessionEvents();
			// A cold-resumed session is a brand-new Session object with an empty
			// query-metadata cache (#130) even though the CLI conversation itself is old —
			// hide the gauge until this session's own first turn captures a fresh value.
			this.view.view.configToolbar.updateContextIndicator();

			// Restore the agent that was used in this session
			this.restoreAgentFromSessionName(sessionId);

			// Force scroll to the end of the loaded conversation
			this.view.view.forceScrollToBottom();

			this.renderSessionList();
			this.view.view.renderer.updateSendButton();
			// restoreAgentFromSessionName() above may have changed selectedAgent, so refresh the
			// state line too, not just the kicker (#217).
			this.view.view.refreshComposerState();
		} catch (e) {
			if (this.selectionToken !== token) return;
			this.view.view.renderer.addInfoMessage(`Failed to load session: ${String(e)}`);
			this.view.view.renderer.renderWelcome();
			this.view.view.currentSessionId = null;
			this.renderSessionList();
			this.view.view.refreshComposerState();
		}
	}

	private showSessionContextMenu(e: MouseEvent, sessionId: string): void {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();

		menu.addItem(item => item
			.setTitle('Rename')
			.setIcon('pencil')
			.onClick(() => this.renameSession(sessionId)));

		menu.addItem(item => item
			.setTitle('Delete')
			.setIcon('trash-2')
			.onClick(() => void this.deleteSessionById(sessionId)));

		menu.showAtMouseEvent(e);
	}

	renameSession(sessionId: string): void {
		const rawName = this.view.view.sessionNames[sessionId] || '';
		// Extract prefix and display name
		const prefixMatch = rawName.match(/^(\[(chat|inline|trigger)\]\s*)/);
		const prefix = prefixMatch ? prefixMatch[1] : '';
		const displayName = prefix ? rawName.slice(prefix.length) : rawName;

		const modal = new Modal(this.view.app);
		modal.titleEl.setText('Rename session');

		const input = modal.contentEl.createEl('input', {
			type: 'text',
			value: displayName,
			cls: 'synapse-rename-input',
		});


		const btnRow = modal.contentEl.createDiv({cls: 'synapse-approval-buttons'});
		const saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		saveBtn.addEventListener('click', () => {
			const newName = input.value.trim();
			if (newName) {
				this.view.view.sessionNames[sessionId] = `${prefix}${newName}`;
				this.view.view.saveSessionNames();
				this.renderSessionList();
				this.view.view.updateMastheadKicker();
			}
			modal.close();
		});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => modal.close());

		// Enter key to save
		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				saveBtn.click();
			}
		});

		modal.open();
		input.focus();
		input.select();
	}

	async deleteSessionById(sessionId: string): Promise<void> {
		// If this is the foreground session and it's actively streaming, interrupt
		// the in-flight run first (same abort path as the stop button) so we don't
		// delete the session out from under a still-running stream.
		if (sessionId === this.view.view.currentSessionId && this.view.view.isStreaming) {
			await this.view.view.handleAbort();
		}

		// Clean up background session if it exists
		const bg = this.view.view.activeSessions.get(sessionId);
		if (bg) {
			bg.detach();
			try { await bg.session.disconnect(); } catch { /* ignore */ }
			this.view.view.activeSessions.delete(sessionId);
		}

		try {
			await this.view.plugin.agentService!.deleteSession(sessionId);
		} catch (e) {
			new Notice(`Failed to delete session: ${String(e)}`);
			return;
		}

		delete this.view.view.sessionNames[sessionId];
		this.view.view.saveSessionNames();
		// Drop the persisted cost baseline too (issue #269 AC-1) — a deleted session id will
		// never be cold-resumed again, so there's nothing left for it to seed.
		if (this.view.plugin.settings?.sessionCostBaselines) {
			delete this.view.plugin.settings.sessionCostBaselines[sessionId];
			void this.view.plugin.saveSettings();
		}
		this.view.view.sessionList = this.view.view.sessionList.filter(s => s.sessionId !== sessionId);

		if (this.view.view.currentSessionId === sessionId) {
			this.view.view.currentSessionId = null;
			this.view.view.currentSession = null;
			this.view.view.newConversation();
		}

		this.renderSessionList();
		new Notice('Session deleted.');
	}

	private confirmDeleteSession(sessionId: string): void {
		const session = this.view.view.sessionList.find(s => s.sessionId === sessionId);
		const name = session ? this.getSessionDisplayName(session) : 'this session';

		const modal = new Modal(this.view.app);
		modal.titleEl.setText('Delete session');
		modal.contentEl.createEl('p', {
			text: `Are you sure you want to delete "${name}"?`,
		});
		const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
		btnRow.createEl('button', {text: 'Cancel', cls: 'mod-cancel'}).addEventListener('click', () => modal.close());
		const confirmBtn = btnRow.createEl('button', {text: 'Delete', cls: 'mod-warning'});
		confirmBtn.addEventListener('click', () => {
			modal.close();
			void this.deleteSessionById(sessionId);
		});
		modal.open();
	}

	private confirmDeleteDisplayedSessions(): void {
		const displayed = this.getDisplayedSessions();
		if (displayed.length === 0) {
			new Notice('No sessions to delete.');
			return;
		}

		const modal = new Modal(this.view.app);
		modal.titleEl.setText('Delete sessions');
		modal.contentEl.createEl('p', {
			text: `Are you sure you want to delete ${displayed.length} session${displayed.length === 1 ? '' : 's'}?`,
		});
		const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
		btnRow.createEl('button', {text: 'Cancel', cls: 'mod-cancel'}).addEventListener('click', () => modal.close());
		const confirmBtn = btnRow.createEl('button', {text: 'Delete', cls: 'mod-warning'});
		confirmBtn.addEventListener('click', () => {
			modal.close();
			void this.deleteDisplayedSessions(displayed);
		});
		modal.open();
	}

	private getDisplayedSessions(): SessionMetadata[] {
		return this.view.view.sessionList.filter(session => {
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) return false;
			}
			if (this.sessionFilter) {
				const name = this.getSessionDisplayName(session);
				if (!name.toLowerCase().includes(this.sessionFilter)) return false;
			}
			return true;
		});
	}

	private async deleteDisplayedSessions(sessions: SessionMetadata[]): Promise<void> {
		let deleted = 0;
		for (const session of sessions) {
			try {
				await this.deleteSessionById(session.sessionId);
				deleted++;
			} catch { /* continue with remaining */ }
		}
		new Notice(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}.`);
	}
}
