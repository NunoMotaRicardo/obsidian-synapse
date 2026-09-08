import {App, MarkdownRenderer} from 'obsidian';
import type {Component} from 'obsidian';

/**
 * Strip the leading session-type prefix (`[chat]`, `[inline]`, `[trigger]`, `[search]`) that
 * session names are stored with internally, for display or agent-name parsing. Shared by
 * sessionSidebar.ts (`getSessionDisplayName`, `restoreAgentFromSessionName`) and
 * synapseView.ts (`updateMastheadKicker`) so the prefix scheme only needs updating once (#217).
 */
export function stripSessionTypePrefix(raw: string): string {
	return raw.replace(/^\[(chat|inline|trigger|search)\]\s*/, '');
}

export function formatTimeAgo(d: Date): string {
	const now = Date.now();
	const diff = now - d.getTime();
	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return 'Just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days === 1) return 'Yesterday';
	if (days < 7) return `${days}d ago`;
	return d.toLocaleDateString();
}

export async function renderMarkdownSafe(app: App, content: string, container: HTMLElement, component: Component): Promise<void> {
	try {
		// Strip obsidian:// protocol URIs that could trigger vault actions
		// when rendered as clickable links from AI-generated content.
		const sanitized = content.replace(
			/\[([^\]]*)\]\(obsidian:\/\/[^)]*\)/gi,
			'[$1](blocked-uri)',
		);
		await MarkdownRenderer.render(app, sanitized, container, '', component);
	} catch {
		// Fallback to plain text
		container.setText(content);
	}
}

/**
 * Strip internal prompt scaffolding (attachments, selections, cursor position,
 * workspace context, vault structure) that `buildPrompt()` and `buildTurnContextBlock()`
 * append to user messages when sending to the LLM. When replaying messages from an
 * SDK session transcript, stripping these blocks ensures the chat transcript only
 * displays the user's genuine prompt.
 */
export function stripInjectedPromptContext(text: string): string {
	let cleaned = text;

	// Strip turn context blocks ([Workspace Path Information], [Vault Structure], [Self-Improve])
	cleaned = cleaned.replace(/\n\n\[Workspace Path Information\][\s\S]*/, '');
	cleaned = cleaned.replace(/\n\n\[Vault Structure\][\s\S]*/, '');
	cleaned = cleaned.replace(/\n\n\[Self-Improve\][\s\S]*/, '');

	// Strip scope blocks
	cleaned = cleaned.replace(/(?:\n\n|\s*)---\s*(?:Entire vault scope|Scope folders):[\s\S]*?(?=(?:\n\n|\s*)---|$)/g, '');

	// Strip attachment file/image/directory path blocks (multiline or inline)
	cleaned = cleaned.replace(
		/(?:\n\n|\s*)---\s*Attached (?:file|image|directory):\s*[^\r\n]+?(?=\s*Path:|\r?\n|$)(?:\r?\n|\s*)Path:\s*[^\r\n]+?(?=\s*---|\r?\n|$)/g,
		''
	);

	// Strip cursor position blocks (multiline or inline)
	cleaned = cleaned.replace(/(?:\n\n|\s*)---\s*Current cursor position:\s*[^\r\n]+?(?=\s*---|\r?\n|$)/g, '');

	// Strip selected text and clipboard content blocks
	cleaned = cleaned.replace(/(?:\n\n|\s*)---\s*(?:Selected text(?: from [^\r\n]+)?|Clipboard content):\r?\n[\s\S]*?(?=(?:\n\n|\s*)---|$)/g, '');

	return cleaned.trim();
}

