import {normalizePath, TFile} from 'obsidian';
import type {App} from 'obsidian';
import type {ModelInfo} from '../agentService';
import {scanVaultStructure} from '../configWriter';
import type {AgentConfig, ChatAttachment} from '../types';
import {IMAGE_EXTS} from '../types';

// Lazy-loaded Node built-ins (same pattern as agentService.ts / runtimeManager.ts) —
// used only for writing clipboard/blob attachments to temp files.
const nodeRequire = typeof window.require === 'function' ? window.require : undefined;

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
 * Resolve a ChatAttachment's `path` (file/image/directory/selection) to an absolute
 * OS path. Vault-relative paths are joined with `vaultBasePath`; `absolutePath: true`
 * attachments are used as-is.
 */
function resolveAttachmentPath(att: ChatAttachment, vaultBasePath: string): string | undefined {
	if (!att.path) return undefined;
	return att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
}

/**
 * Write a base64-encoded blob attachment (e.g. clipboard-pasted image) to a temp file
 * so it can be referenced by an absolute path like any other file attachment.
 * Returns the absolute path of the written file, or undefined on failure.
 */
async function writeBlobToTempFile(att: ChatAttachment): Promise<string | undefined> {
	if (!att.data) return undefined;
	try {
		const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
		const os = nodeRequire?.('node:os') as typeof import('node:os') ?? await import('node:os');
		const path = nodeRequire?.('node:path') as typeof import('node:path') ?? await import('node:path');

		const dir = path.join(os.tmpdir(), 'obsidian-synapse-attachments');
		await fs.mkdir(dir, {recursive: true});

		const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
		const ext = safeName.includes('.') ? '' : (att.mimeType?.startsWith('image/') ? `.${att.mimeType.split('/')[1]}` : '');
		const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}${ext}`;
		const filePath = path.join(dir, fileName);

		await fs.writeFile(filePath, Buffer.from(att.data, 'base64'));
		return filePath;
	} catch (e) {
		console.error('[synapse] Failed to write blob attachment to temp file:', e);
		return undefined;
	}
}

/**
 * Delete previously-written blob attachment temp files. Best-effort — failures are
 * logged, not thrown, since this runs on session end / view unload cleanup paths.
 */
export async function cleanupAttachmentTempFiles(paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	try {
		const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
		await Promise.all(paths.map(async (p) => {
			try {
				await fs.unlink(p);
			} catch {
				// already gone or inaccessible — ignore
			}
		}));
	} catch (e) {
		console.error('[synapse] Failed to clean up attachment temp files:', e);
	}
}

/**
 * Build the user prompt, inlining clipboard content, selection text, file/image
 * attachment paths, and cursor position.
 *
 * File/image/blob attachments are inlined as absolute paths (rather than sent via a
 * separate SDK attachments channel) because `query()`'s `Options` has no top-level
 * `attachments` field — the Agent SDK only accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
 * Giving the model a real absolute path lets it use its own `Read` tool (which already
 * supports image files) to actually see the content. Blob attachments (clipboard-pasted
 * images with no path) are first written to a temp file via `materializeBlobAttachments()`
 * (the resulting `blobPaths` map is passed in here); those temp file paths should also be
 * threaded to `computeAdditionalDirectories()`/`Session.send({additionalDirectories})` and
 * cleaned up via `cleanupAttachmentTempFiles()` when the view/session ends.
 */
export function buildPrompt(
	basePrompt: string,
	attachments: ChatAttachment[],
	cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null,
	activeSelection: {filePath: string; text: string} | null,
	vaultBasePath: string,
	blobPaths: Map<ChatAttachment, string>,
	scopePaths: string[] = [],
): string {
	let prompt = basePrompt;

	// Vault scope — inline vault-relative scope paths so the model knows which
	// folders/files it should focus on. These are always inside the vault root
	// (already readable via cwd), so no additionalDirectories entry is needed.
	if (scopePaths.length > 0) {
		const list = scopePaths.map(p => p === '/' ? '(entire vault)' : p).join(', ');
		prompt += `\n\n---\nVault scope (focus on these paths): ${list}`;
	}

	// Inline file/image attachment paths so the model has a real absolute path it can
	// Read itself (same "the transport strips extra fields" rationale as selection below).
	const fileAttachments = attachments.filter(a => a.type === 'file' || a.type === 'image');
	for (const att of fileAttachments) {
		const blobPath = blobPaths.get(att);
		const resolvedPath = blobPath ?? resolveAttachmentPath(att, vaultBasePath);
		if (resolvedPath) {
			const label = att.type === 'image' ? 'Attached image' : 'Attached file';
			prompt += `\n\n---\n${label}: ${att.name}\nPath: ${resolvedPath}`;
		}
	}

	// Directory attachments — inline the path so the model knows where to look;
	// additionalDirectories (computed separately) grants read access if it's outside cwd.
	const directoryAttachments = attachments.filter(a => a.type === 'directory');
	for (const dir of directoryAttachments) {
		const resolvedPath = resolveAttachmentPath(dir, vaultBasePath);
		if (resolvedPath) {
			prompt += `\n\n---\nAttached directory: ${dir.name}\nPath: ${resolvedPath}`;
		}
	}

	// Clipboard-pasted text content is inlined directly (no path — it's not a file).
	const clipboards = attachments.filter(a => a.type === 'clipboard');
	for (const clip of clipboards) {
		if (clip.content) {
			prompt += `\n\n---\nClipboard content:\n${clip.content}`;
		}
	}

	// Blob attachments without inline text content (e.g. clipboard-pasted images) —
	// inline the temp file path the caller wrote them to.
	const blobAttachments = attachments.filter(a => a.type === 'blob');
	for (const blob of blobAttachments) {
		const blobPath = blobPaths.get(blob);
		if (blobPath) {
			prompt += `\n\n---\nAttached image: ${blob.name}\nPath: ${blobPath}`;
		}
	}

	// Inline selection text in the prompt because the Claude CLI server's
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
 * Write any `type: 'blob'` attachments (clipboard-pasted images, no path) to temp files
 * so they can be inlined into the prompt like any other file attachment. Returns a map
 * from attachment to the absolute temp file path it was written to (attachments that
 * failed to write are omitted — the model just won't see them).
 */
export async function materializeBlobAttachments(attachments: ChatAttachment[]): Promise<Map<ChatAttachment, string>> {
	const result = new Map<ChatAttachment, string>();
	const blobs = attachments.filter(a => a.type === 'blob' && a.data);
	await Promise.all(blobs.map(async (att) => {
		const path = await writeBlobToTempFile(att);
		if (path) result.set(att, path);
	}));
	return result;
}

/**
 * Path-boundary-aware containment check: is `target` equal to or nested inside `base`?
 * Unlike a raw string `startsWith`, this won't false-positive on sibling paths that
 * merely share a string prefix (e.g. base `C:/vault` vs target `C:/vault-backup/x`).
 *
 * Uses `path.relative()` and checks the result is neither empty/absolute nor a `..`
 * escape — the standard "is target inside base" pattern. Falls back to a normalized
 * string-equality/prefix check (with an explicit separator boundary) if Node's `path`
 * module isn't available.
 */
function isPathInside(target: string, base: string): boolean {
	const path = nodeRequire?.('node:path') as typeof import('node:path') | undefined;
	if (path) {
		const rel = path.relative(base, target);
		return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
	}
	// Fallback: normalize slashes/case and require a path-separator boundary.
	const normalizedTarget = target.replace(/\\/g, '/').toLowerCase();
	const normalizedBase = base.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
	return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + '/');
}

/** Simple file-extension -> MIME type map for image attachments sent to local providers. */
const IMAGE_MIME_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
};

/**
 * Resolve `type: 'image'`, image-extension `type: 'file'`, and `type: 'blob'` attachments
 * to base64-encoded content for local/BYOK providers, which have no agentic `Read` tool and
 * so need the actual image bytes rather than a path inlined into the prompt text (see
 * `buildPrompt()`'s doc comment for why paths are inlined for the Agent SDK path instead).
 *
 * Blob attachments (clipboard-pasted or drag/dropped images) already carry base64 `data` —
 * reused directly rather than re-reading the temp file `materializeBlobAttachments()` wrote it
 * to, but only when `mimeType` is one of the raster types in `IMAGE_MIME_TYPES`; a dragged/
 * pasted `.svg` reports `image/svg+xml` and is skipped for the same reason as below. File/image
 * attachments are read from disk and base64-encoded; `svg` is excluded even though it's in
 * `IMAGE_EXTS` because `image_url` data URIs for SVG aren't reliably supported by vision
 * models — it's treated like a non-image file and skipped (same "no clean path forward" gap
 * as other non-image files). Failures (missing file, read error) are logged and skipped, not
 * thrown — same resilience pattern as `writeBlobToTempFile()`.
 */
export async function resolveImageAttachments(
	attachments: ChatAttachment[],
	blobPaths: Map<ChatAttachment, string>,
	vaultBasePath: string,
): Promise<Array<{mimeType: string; base64: string}>> {
	const results: Array<{mimeType: string; base64: string}> = [];

	const supportedBlobMimeTypes = new Set(Object.values(IMAGE_MIME_TYPES));
	const blobAttachments = attachments.filter(a => a.type === 'blob' && a.data);
	for (const att of blobAttachments) {
		const mimeType = att.mimeType || 'image/png';
		if (!supportedBlobMimeTypes.has(mimeType)) continue; // e.g. image/svg+xml (dragged/pasted .svg) — same "no reliable delivery" gap as file-attachment svgs
		results.push({mimeType, base64: att.data!});
	}

	const fileAttachments = attachments.filter(a => a.type === 'image' || a.type === 'file');
	if (fileAttachments.length === 0) return results;

	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');

	for (const att of fileAttachments) {
		const ext = (att.name || att.path || '').split('.').pop()?.toLowerCase() ?? '';
		const mimeType = IMAGE_MIME_TYPES[ext];
		if (!mimeType) continue; // not an image extension (or svg) — skip, no delivery path for local providers

		const blobPath = blobPaths.get(att);
		const resolvedPath = blobPath ?? resolveAttachmentPath(att, vaultBasePath);
		if (!resolvedPath) continue;

		try {
			const buf = await fs.readFile(resolvedPath);
			results.push({mimeType, base64: buf.toString('base64')});
		} catch (e) {
			console.error('[synapse] Failed to read image attachment for local provider:', resolvedPath, e);
		}
	}

	return results;
}

/**
 * Compute the list of directories to pass as `Options.additionalDirectories` for a
 * query, so the SDK grants read access to attachment paths that fall outside the
 * session's actual `cwd` — e.g. absolute Windows paths, OneDrive-synced folders, blob
 * temp files, or vault-relative attachments that fall outside a scoped working
 * directory.
 *
 * `vaultBasePath` is used only to resolve vault-relative attachment paths to absolute
 * paths (vault-relative paths are always joined against the vault root, not the
 * working directory). `workingDirectory` is the actual session `cwd` — the boundary
 * used to decide whether a resolved path is "already readable" and can be omitted.
 * These are frequently the same value (unscoped working directory), but must not be
 * conflated when the user has scoped the working directory to a subfolder.
 */
export function computeAdditionalDirectories(params: {
	attachments: ChatAttachment[];
	blobPaths: Map<ChatAttachment, string>;
	vaultBasePath: string;
	workingDirectory: string;
	scopePaths?: string[];
	app?: App;
}): string[] {
	const {attachments, blobPaths, vaultBasePath, workingDirectory, scopePaths = [], app} = params;
	const dirs = new Set<string>();
	const path = nodeRequire?.('node:path') as typeof import('node:path') | undefined;

	const addForPath = (absPath: string, isDirectory: boolean) => {
		const normalized = absPath.replace(/\\/g, '/');
		const normalizedCwd = workingDirectory.replace(/\\/g, '/');
		if (isPathInside(normalized, normalizedCwd)) return; // already readable via cwd

		let dir: string;
		if (isDirectory) {
			dir = normalized;
		} else {
			if (path) {
				dir = path.dirname(absPath).replace(/\\/g, '/');
			} else {
				const idx = normalized.lastIndexOf('/');
				dir = idx === -1 ? '' : normalized.slice(0, idx);
			}
		}

		// Ensure Windows drive-root gets trailing slash (e.g. C: -> C:/)
		if (dir && /^[a-zA-Z]:$/.test(dir)) {
			dir += '/';
		}
		if (dir) dirs.add(dir);
	};

	for (const att of attachments) {
		if (att.type === 'file' || att.type === 'image' || att.type === 'selection') {
			const resolvedPath = resolveAttachmentPath(att, vaultBasePath);
			if (resolvedPath) addForPath(resolvedPath, false);
		} else if (att.type === 'directory') {
			const resolvedPath = resolveAttachmentPath(att, vaultBasePath);
			if (resolvedPath) addForPath(resolvedPath, true);
		}
	}

	for (const blobPath of blobPaths.values()) {
		addForPath(blobPath, false);
	}

	for (const scopePath of scopePaths) {
		const normalizedScope = scopePath === '/' ? '' : normalizePath(scopePath);
		const absPath = scopePath === '/' ? vaultBasePath : vaultBasePath + '/' + normalizedScope;
		let isDir = false;
		if (scopePath === '/') {
			isDir = true;
		} else if (app) {
			const abstract = app.vault.getAbstractFileByPath(normalizedScope);
			if (abstract && 'children' in abstract) { // TFolder
				isDir = true;
			}
		}
		addForPath(absPath, isDir);
	}

	return Array.from(dirs);
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
 * Build a compact resilience hint for the system prompt: instructs the agent to retry a
 * failed write/edit once before giving up (and ask the user rather than silently abandoning
 * or claiming partial success), and to confirm it actually read referenced attachments/files
 * before acting on their content rather than guessing or fabricating.
 */
export function buildResilienceHint(): string {
	return '\n\n[Resilience] If a Write/Edit/NotebookEdit tool call fails (e.g. a file locked by sync or open elsewhere),' +
		' retry the same edit once. If it fails again, stop, clearly tell the user what happened and which file was affected,' +
		' and ask before doing anything else (e.g. suggesting they close the file or retry manually) — never silently abandon the task or claim it succeeded when it did not.' +
		' Before acting on a referenced attachment or file, confirm you actually read its content via a tool result' +
		' (do not assume or infer content you have not seen). If a referenced file cannot be found or read, stop and ask the user' +
		' to confirm the path or re-attach it instead of proceeding with guessed or fabricated content.';
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
