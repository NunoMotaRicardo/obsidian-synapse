import {normalizePath, TFile} from 'obsidian';
import type {App} from 'obsidian';
// Type imports stay type-only; `matchModelTiers` is the one value import from the single
// SDK service module (no cycle: agentService.ts does not import this module).
import type {ModelInfo, SlashCommand, AgentInfo} from '../agentService';
import {matchModelTiers} from '../agentService';
import {scanVaultStructure} from '../configWriter';
import type {AgentConfig, ChatAttachment, SkillInfo} from '../types';
import {IMAGE_EXTS} from '../types';
import {nodeRequire} from '../nodeRequire';

/**
 * Resolve a model ID from an agent's preferred model name / partial match.
 * Returns the matching model ID, or falls back to `fallback` when the
 * agent's model doesn't match any available model (avoids passing unknown
 * model IDs to the SDK).
 *
 * The tier search itself lives in one shared place — `matchModelTiers()` in
 * `agentService.ts` (audit rec 4); this wrapper keeps only its own preconditions
 * (`!agent?.model` → `fallback`) and fallback semantics.
 */
export function resolveModelForAgent(agent: AgentConfig | undefined, models: ModelInfo[], fallback: string | undefined): string | undefined {
	if (!agent?.model) return fallback;
	const match = matchModelTiers(agent.model, models);
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
 * Build a compact vault-structure context block listing top-level folder names.
 * Returns an empty string when the vault has no scannable folders.
 *
 * Folder names only — no `(N items)` counts (issue #201). Counts changed whenever the
 * vault's contents changed, which made this block volatile; it's delivered per-turn in
 * the user message (see `synapseView.ts`'s `handleSend()`) rather than the system prompt,
 * so being volatile no longer costs a cache invalidation, but the counts were dropped
 * outright rather than kept and moved — they added noise without the model needing exact
 * numbers to decide where to look.
 */
export function buildVaultContextBlock(
	app: App,
): string {
	const folders = scanVaultStructure(app);
	if (folders.length === 0) return '';
	const list = folders.map(f => f.name).join(', ');
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
 *
 * Session-stable — no longer takes an `agentName` (issue #201): the "Current agent" line it
 * used to append is volatile (a `configDirty` rebuild can change the selected agent for a
 * resumed conversation) and is now delivered per-turn via `buildCurrentAgentLine()` instead,
 * so this static body can stay in `systemPrompt.append` without invalidating the cached
 * prefix whenever the agent changes.
 */
export function buildSelfImproveHint(): string {
	return '\n\n[Self-Improve] If the user expresses a preference about how Synapse should behave' +
		' (e.g. "always use APA citations" or "make the assistant more concise"),' +
		' propose creating or modifying a Synapse customization artifact (agent or skill).' +
		' Artifacts live in the _synapse/ folder (.md files for agents in _synapse/agents/, and SKILL.md files for skills in _synapse/skills/<name>/SKILL.md).' +
		' State what you would create (type and summary), then ask permission before writing.';
}

/**
 * Build the volatile "Current agent" line delivered per-turn in the user message rather
 * than baked into `buildSelfImproveHint()`'s static body — see that function's doc comment.
 */
export function buildCurrentAgentLine(agentName: string): string {
	return `\n\nCurrent agent: ${agentName}.`;
}

/**
 * Build the per-turn volatile context block appended to the *user message* rather than
 * `systemPrompt.append` (issue #201): Active note, Working directory, the `[Vault Structure]`
 * block, and (when the current agent isn't `improve-synapse`, matching the self-improve hint's
 * own skip) the current agent. Each of these can change between turns of the same resumed
 * conversation (switching notes, a `configDirty` rebuild changing cwd/agent, vault edits), so
 * baking them into the system prompt would invalidate the cached prefix — and everything
 * behind it in the conversation history — on every such change. Delivered here instead, a
 * change only costs this turn's own tokens.
 */
export function buildTurnContextBlock(opts: {
	app: App;
	vaultRoot: string;
	activeNotePath?: string;
	workingDirectory: string;
	agentName?: string;
}): string {
	const parts: string[] = ['[Workspace Path Information]'];
	if (opts.activeNotePath) parts.push(`Active note: ${opts.vaultRoot}/${opts.activeNotePath}`);
	parts.push(`Working directory: ${opts.workingDirectory}`);
	let block = '\n\n' + parts.join('\n') + buildVaultContextBlock(opts.app);
	if (opts.agentName) block += buildCurrentAgentLine(opts.agentName);
	return block;
}

/** Result of {@link decideWorkingDirAutoUpdate}. */
export interface WorkingDirAutoUpdateDecision {
	/** Whether `workingDir` should be updated (and the session config marked dirty) right now. */
	applyNow: boolean;
	/**
	 * The directory that should become pending — applied once the conversation ends —
	 * when `applyNow` is false and the note actually moved to a different folder.
	 * `null` when there is nothing to defer (directory unchanged, or applied now).
	 */
	pendingDir: string | null;
	/**
	 * Whether any existing `pendingWorkingDir` on the caller should be cleared. True whenever
	 * `pendingDir` is `null` — covers both `applyNow` (the change already landed, so there is
	 * nothing left to defer) and the note returning to `currentWorkingDir` (any earlier deferral
	 * from a since-abandoned detour would otherwise survive and get applied at the wrong time —
	 * see the "stale pendingWorkingDir" scenario in this function's doc comment).
	 */
	clearPending: boolean;
}

/**
 * Decide whether an active-note-driven working-directory change should be applied
 * immediately or deferred until the conversation ends (issue #108, restored by #202).
 *
 * Applying a `cwd` change mid-conversation makes `ensureSession()` tear down the live
 * `Session` and rebuild it, resuming by id. A resumed session is a **new CLI process that
 * replays the whole transcript**, so every rebuild re-writes the entire conversation to the
 * prompt cache. Users switch the active note between essentially every turn, so an
 * immediate-apply policy pays that replay cost on a large share of follow-up messages.
 *
 * This is a pure token-cost concern, not a correctness one: `ensureSession()` already seeds
 * the rebuilt `SessionConfig` with the outgoing session's id (issue #104's `resume`
 * fallback via `resolveResumeSessionId()` in `agentService.ts`), so no transcript is lost,
 * and resuming under a changed `cwd` has been verified not to degrade the model's path
 * handling (see `.docs/decisions/2026-09-03-cwd-deferral-removed.md`). Deferring simply
 * avoids paying for a rebuild on every note switch: the directory change is held in
 * `pendingWorkingDir` while a conversation is in progress — the working-directory button
 * doesn't move and no rebuild happens — and applied the next time a conversation is *not*
 * in progress (`newConversation()`).
 *
 * Returning to `currentWorkingDir` mid-conversation must **cancel** any pending deferral
 * from an earlier detour, not just leave it as a no-op: a user chatting about a note in
 * folder A, glancing at a note in folder B (deferred), and coming back to A before ending the
 * conversation is looking at A when the conversation ends, so the working directory must stay
 * A — not silently jump to the abandoned B. `clearPending` on the returned decision signals
 * this to the caller (`inputArea.ts#updateActiveNote()`), which must clear its
 * `pendingWorkingDir` whenever `clearPending` is true, regardless of `pendingDir`.
 */
export function decideWorkingDirAutoUpdate(params: {
	newDir: string;
	currentWorkingDir: string;
	conversationInProgress: boolean;
}): WorkingDirAutoUpdateDecision {
	const {newDir, currentWorkingDir, conversationInProgress} = params;
	if (newDir === currentWorkingDir) return {applyNow: false, pendingDir: null, clearPending: true};
	if (conversationInProgress) return {applyNow: false, pendingDir: newDir, clearPending: false};
	return {applyNow: true, pendingDir: null, clearPending: true};
}

/**
 * Map the CLI's live `supportedCommands()` list (issue #130) into the `SkillInfo` shape the
 * slash-command popup (`inputArea.ts`) already renders. `SlashCommand` has no vault folder —
 * `folderPath` is set to `''`, which is never read for CLI-sourced entries (only ever
 * populated/consumed for the directory-scan fallback's own bookkeeping).
 *
 * **Namespaces are split off `name` (issue #163).** The CLI advertises plugin-provided
 * commands as `<plugin>:<command>` — a vault skill `improve-synapse` arrives as
 * `_synapse:improve-synapse`. Carrying that straight through made vault skills
 * undiscoverable: the popup filters on `name`, so typing the skill's own name matched
 * nothing, and an agent's `skills: [improve-synapse]` restriction no longer matched either.
 * So `name` keeps the unqualified command — what the user wrote and types — and the full
 * namespaced id moves to `qualifiedName`, which is what gets inserted.
 */
export function mapSlashCommandsToSkillInfo(commands: SlashCommand[]): SkillInfo[] {
	return commands.map(c => {
		const {name, qualifiedName} = splitCommandNamespace(c.name);
		return {
			name,
			description: c.description,
			folderPath: '',
			...(qualifiedName ? {qualifiedName} : {}),
		};
	});
}

/**
 * Split a CLI command id into its unqualified name and, when it carries a `<plugin>:` prefix,
 * the full namespaced id (issue #163).
 *
 * Splits on the **last** colon, so a plugin whose own name contains one still yields the
 * command as the caller typed it. A command with no colon is returned unchanged with no
 * `qualifiedName`, which is what leaves non-plugin commands untouched. A trailing colon (no
 * command after it) is treated as no namespace at all rather than producing an empty name.
 */
export function splitCommandNamespace(commandName: string): {name: string; qualifiedName?: string} {
	const idx = commandName.lastIndexOf(':');
	if (idx < 0) return {name: commandName};
	const unqualified = commandName.slice(idx + 1);
	if (!unqualified) return {name: commandName};
	return {name: unqualified, qualifiedName: commandName};
}

/**
 * Map the CLI's live `supportedAgents()` list (issue #130) into the `AgentConfig` shape the
 * agent picker (`configToolbar.ts`) already renders/selects from. `AgentInfo` has no
 * instructions body or vault file — `instructions` falls back to `description` (used for the
 * dropdown's tooltip), `filePath` is `''` (never read for CLI-sourced entries), and
 * `skills`/`tools` are left `undefined` because `AgentInfo` carries no equivalent data.
 *
 * **That last point makes this mapping lossy, so callers must not use it alone for an agent
 * the vault also knows about.** `applyAgentToolsAndSkills()` reads `skills: undefined` as
 * "enable all", so substituting this result for a scanned `AgentConfig` that declared
 * `skills: [...]` would silently widen a deliberately narrowed agent.
 * `configToolbar.ts#getEffectiveAgents()` therefore merges by name — the CLI decides which
 * agents exist, the directory scan supplies the config for those it also knows.
 */
export function mapAgentInfoToAgentConfig(agents: AgentInfo[]): AgentConfig[] {
	return agents.map(a => ({
		name: a.name,
		description: a.description,
		...(a.model ? {model: a.model} : {}),
		instructions: a.description,
		filePath: '',
	}));
}

/**
 * Reconcile the CLI's live agent list with the vault directory scan (issue #130).
 *
 * The CLI decides **membership** — it is authoritative about which agents actually loaded,
 * so an agent the scan found but the CLI did not is genuinely unavailable and is dropped.
 * The scan supplies the **config** for any agent present in both, because `AgentInfo` has no
 * `tools`/`skills`/`instructions` and substituting the lossy mapping would discard a vault
 * agent's declared restrictions — see `mapAgentInfoToAgentConfig()`.
 */
export function mergeLiveAgents(live: AgentInfo[], scanned: AgentConfig[]): AgentConfig[] {
	const byName = new Map(scanned.map(a => [a.name, a]));
	return mapAgentInfoToAgentConfig(live).map(a => byName.get(a.name) ?? a);
}

/**
 * Reconcile the CLI's live slash-command list with the vault skill scan (issue #130), on the
 * same rule as `mergeLiveAgents()`: the CLI decides membership, the scan supplies the config
 * so a vault skill keeps its `folderPath` rather than being flattened to `''`.
 *
 * Matching is on the **unqualified** name (issue #163), since `mapSlashCommandsToSkillInfo()`
 * has already split any `<plugin>:` prefix off — a CLI `_synapse:improve-synapse` therefore
 * finds the scanned `improve-synapse` instead of falling through as a separate entry. When the
 * scanned entry wins, the CLI's `qualifiedName` is carried onto it: the vault copy knows the
 * folder, only the CLI knows the id that resolves, and the popup needs both.
 */
export function mergeLiveSkills(live: SlashCommand[], scanned: SkillInfo[]): SkillInfo[] {
	const byName = new Map(scanned.map(s => [s.name, s]));
	return mapSlashCommandsToSkillInfo(live).map(s => {
		const match = byName.get(s.name);
		if (!match) return s;
		return s.qualifiedName ? {...match, qualifiedName: s.qualifiedName} : match;
	});
}
