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

export function describeCron(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return `Cron: ${cron}`;
	const [min, hour, dom, mon, dow] = parts;

	// */N minute patterns
	const everyMin = min!.match(/^\*\/(\d+)$/);
	if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
		return `Every ${everyMin[1]} minute(s)`;
	}
	// Daily at HH:MM
	if (/^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === '*' && mon === '*' && dow === '*') {
		return `Daily at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
	}
	// Weekly (specific dow)
	if (/^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === '*' && mon === '*' && /^\d+$/.test(dow!)) {
		const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const day = days[parseInt(dow!, 10)] ?? dow;
		return `Weekly on ${day} at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
	}
	// Hourly at :MM
	if (/^\d+$/.test(min!) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
		return `Hourly at :${min!.padStart(2, '0')}`;
	}
	return `Cron: ${cron}`;
}

export function describeGlob(glob: string): string {
	// **/*.ext — all .ext files recursively
	const recursiveExt = glob.match(/^\*\*\/\*\.([\w]+)$/);
	if (recursiveExt) return `All .${recursiveExt[1]} files (recursive)`;
	// *.ext — .ext files in root
	const rootExt = glob.match(/^\*\.([\w]+)$/);
	if (rootExt) return `.${rootExt[1]} files in root`;
	// folder/**/*.ext
	const folderExt = glob.match(/^(.+)\/\*\*\/\*\.([\w]+)$/);
	if (folderExt) return `All .${folderExt[2]} files in ${folderExt[1]}/`;
	// folder/** — everything under folder
	const folderAll = glob.match(/^(.+)\/\*\*$/);
	if (folderAll) return `All files in ${folderAll[1]}/`;
	return `Glob: ${glob}`;
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
