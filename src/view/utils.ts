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
