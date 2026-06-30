import {normalizePath, TFile, TFolder} from 'obsidian';
import type {App} from 'obsidian';
import type {ModelInfo} from '../copilot';
import {scanVaultStructure} from '../configWriter';

/** Minimal MessageOptions shape for SDK attachments. */
interface MessageOptions {
	attachments?: Array<{type: string; path?: string; data?: string; mimeType?: string; displayName?: string}>;
}
import type {AgentConfig, ChatAttachment} from '../types';
import {IMAGE_EXTS} from '../types';


/**
 * Resolve a model ID from an agent's preferred model name / partial match.
 * Returns the matching model ID, or falls back to `fallback` when the
 * agent's model doesn't match any available model (avoids passing unknown
 * model IDs to the SDK).
 */
export function resolveModelForAgent(agent: AgentConfig | undefined, models: ModelInfo[], fallback: string | undefined): string | undefined {
	if (!agent?.model) return fallback;
	const target = agent.model.toLowerCase();
	let match = models.find(
		m => m.name.toLowerCase() === target || m.id.toLowerCase() === target
	);
	if (!match) {
		match = models.find(
			m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target) || target.includes(m.id.toLowerCase())
		);
	}
	if (!match) {
		for (const key of ['haiku', 'sonnet', 'opus', 'flash', 'pro']) {
			if (target.includes(key)) {
				match = models.find(m => m.id.toLowerCase().includes(key) || m.name.toLowerCase().includes(key));
				if (match) break;
			}
		}
	}
	return match ? match.id : fallback;
}

/**
 * Build the user prompt, inlining clipboard content, selection text, and cursor position.
 */
export function buildPrompt(
	basePrompt: string,
	attachments: ChatAttachment[],
	cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null,
	activeSelection: {filePath: string; text: string} | null,
): string {
	let prompt = basePrompt;
	const clipboards = attachments.filter(a => a.type === 'clipboard');
	for (const clip of clipboards) {
		if (clip.content) {
			prompt += `\n\n---\nClipboard content:\n${clip.content}`;
		}
	}
	// Inline selection text in the prompt because the Copilot CLI server's
	// session.send handler normalises all attachments to {type, path, displayName},
	// stripping the selection-specific fields (filePath, text, selection range).
	const selections = attachments.filter(a => a.type === 'selection');
	for (const sel of selections) {
		if (sel.content) {
			const range = sel.selection
				? sel.selection.startLine === sel.selection.endLine
					? `line ${sel.selection.startLine}`
					: `lines ${sel.selection.startLine}-${sel.selection.endLine}`
				: '';
			const header = sel.path
				? `Selected text from ${sel.path}${range ? ` (${range})` : ''}`
				: 'Selected text';
			prompt += `\n\n---\n${header}:\n${sel.content}`;
		}
	}
	// Include cursor position so the model knows where the user's cursor is
	if (cursorPosition && !activeSelection) {
		prompt += `\n\n---\nCurrent cursor position: ${cursorPosition.filePath}, line ${cursorPosition.line}, column ${cursorPosition.ch}`;
	}
	return prompt;
}

/**
 * Build SDK-compatible attachments array from ChatAttachment items and scope paths.
 */
export function buildSdkAttachments(params: {
	attachments: ChatAttachment[];
	scopePaths: string[];
	vaultBasePath: string;
	app: App;
}): MessageOptions['attachments'] {
	const {attachments, scopePaths, vaultBasePath, app} = params;
	const result: NonNullable<MessageOptions['attachments']> = [];

	for (const att of attachments) {
		if ((att.type === 'file' || att.type === 'image') && att.path) {
			const filePath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'file',
				path: filePath,
				displayName: att.name,
			});
		} else if (att.type === 'blob' && att.data && att.mimeType) {
			result.push({
				type: 'blob',
				data: att.data,
				mimeType: att.mimeType,
				displayName: att.name,
			});
		} else if (att.type === 'selection' && att.path) {
			// Workaround: send as 'file' instead of 'selection' because the Copilot CLI
			// server's session.send handler maps all attachments to {type, path, displayName},
			// reading .path (not .filePath) and dropping text/selection fields.
			// The selection text is inlined in the prompt by buildPrompt().
			const resolvedPath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'file',
				path: resolvedPath,
				displayName: att.name,
			});
		} else if (att.type === 'directory' && att.path) {
			const dirPath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'directory',
				path: dirPath,
				displayName: att.name,
			});
		}
	}

	// Add vault scope paths (skip children if a parent folder is selected)
	const scopeSorted = [...scopePaths].sort((a, b) => a.length - b.length);
	const includedFolders: string[] = [];

	for (const scopePath of scopeSorted) {
		// Skip if an ancestor folder is already included
		const normalized = normalizePath(scopePath);
		const isChild = includedFolders.some(parent =>
			parent === '/' || normalized.startsWith(parent + '/')
		);
		if (isChild) continue;

		const absPath = scopePath === '/'
			? vaultBasePath
			: vaultBasePath + '/' + normalized;
		const displayName = scopePath === '/' ? app.vault.getName() : scopePath;
		const abstract = scopePath === '/'
			? app.vault.getRoot()
			: app.vault.getAbstractFileByPath(scopePath);

		if (abstract instanceof TFolder) {
			result.push({type: 'directory', path: absPath, displayName});
			includedFolders.push(normalized);
		} else if (abstract instanceof TFile) {
			result.push({type: 'file', path: absPath, displayName});
		}
	}

	return result.length > 0 ? result : undefined;
}

/**
 * Resolve image embeds from note content.
 * Scans for `![[image.ext]]` (wikilink) and `![alt](path.ext)` (markdown) patterns,
 * resolves each to a TFile via Obsidian's metadata cache or vault, and returns them
 * in document order (first match first).
 */
export function resolveNoteImageEmbeds(
	content: string,
	sourcePath: string,
	app: App,
): TFile[] {
	const results: TFile[] = [];
	const seenPaths = new Set<string>();

	// Match both wikilink embeds ![[...]] and markdown embeds ![...](...)
	// Wikilink: ![[filename.ext]] or ![[filename.ext|alias]]
	// Markdown: ![alt](path.ext) or ![alt](path.ext "title")
	const embedRegex = /!\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]|!\[(?:[^\]]*?)\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;

	let match: RegExpExecArray | null;
	while ((match = embedRegex.exec(content)) !== null) {
		const raw = match[1] ?? match[2]; // [1] = wikilink target, [2] = markdown path
		if (!raw) continue;

		// Strip any heading/block references from wikilinks (e.g. ![[image.png#section]])
		const target = raw.split('#')[0]!.trim();
		if (!target) continue;

		// Check if the file extension is an image type
		const ext = target.split('.').pop()?.toLowerCase() ?? '';
		if (!IMAGE_EXTS.has(ext)) continue;

		// Resolve the file
		let file: TFile | null = null;
		if (match[1] !== undefined) {
			// Wikilink: use metadataCache for proper vault-relative resolution
			const resolved = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
			if (resolved instanceof TFile) file = resolved;
		} else {
			// Markdown link: decode URI (when URL-encoded) and resolve relative to the source note
			let decoded = target;
			try {
				decoded = decodeURIComponent(target);
			} catch {
				// ignore decode errors and fall back to the raw target
			}
			const resolved = app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
			if (resolved instanceof TFile) file = resolved;
		}

		if (file && !seenPaths.has(file.path)) {
			seenPaths.add(file.path);
			results.push(file);
		}
	}

	return results;
}

/**
 * Calculates adaptive timeout in milliseconds based on file count in scope.
 */
export function getAdaptiveTimeout(app: App, scopePath?: string, configuredTimeoutSec?: number): number {
	const allFiles = app.vault.getFiles();
	let fileCount = allFiles.length;

	if (scopePath && scopePath !== '/' && scopePath.trim().length > 0) {
		const normScope = normalizePath(scopePath);
		fileCount = allFiles.filter(f => f.path === normScope || f.path.startsWith(normScope + '/')).length;
	}

	const dynamicTimeout = Math.max(120_000, Math.min(600_000, 30_000 + fileCount * 200));
	const configuredMs = (configuredTimeoutSec && configuredTimeoutSec > 0) ? configuredTimeoutSec * 1000 : 0;
	return Math.max(dynamicTimeout, configuredMs);
}

/**
 * Build a compact vault-structure context block listing top-level folders.
 * Returns an empty string when the vault has no scannable folders.
 */
export function buildVaultContextBlock(
	app: App,
): string {
	const folders = scanVaultStructure(app);
	if (folders.length === 0) return '';
	const list = folders.map(f => `${f.name} (${f.fileCount} items)`).join(', ');
	return `\n\n[Vault Structure] Top-level folders: ${list}`;
}

/**
 * Build a compact self-improve detection hint for the system prompt.
 * Teaches the agent to recognize customization intent and propose artifact changes.
 */
export function buildSelfImproveHint(agentName: string): string {
	return '\n\n[Self-Improve] If the user expresses a preference about how Synapse should behave' +
		' (e.g. "always use APA citations", "make the assistant more concise", or "summarize inbox notes every morning"),' +
		' propose creating or modifying a Synapse customization artifact (agent, skill, or trigger).' +
		' Artifacts live in the _synapse/ folder (.md files for agents in _synapse/agents/, SKILL.md files for skills in _synapse/skills/<name>/SKILL.md, and .md files for triggers in _synapse/triggers/).' +
		' Triggers are markdown files in _synapse/triggers/ with frontmatter fields: name (required), description (required), event (one of: file-created, file-modified, file-deleted, file-renamed) or schedule (cron expression, e.g. "0 9 * * *"), and optional fields: path (glob), model, agent, write (true/false/\'frontmatter\'), enabled (true/false). The body is the prompt instructions using {{file}} (event) or {{files}} (scheduled).' +
		' State what you would create (type and summary), then ask permission before writing.' +
		` Current agent: ${agentName}.`;
}
