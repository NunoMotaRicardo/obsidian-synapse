import {App, MarkdownRenderer} from 'obsidian';
import type {Component} from 'obsidian';

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
