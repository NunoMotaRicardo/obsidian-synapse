import {App, normalizePath, TFile, TFolder} from 'obsidian';
import type {AgentConfig, SkillInfo} from './types';
import {SYNAPSE_FOLDER} from './settings';
import {lockManager} from './lockManager';
import {STARTER_FILES} from './starterKit';

/** Module-level compiled regex for frontmatter detection. */
export const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns parsed key-value pairs and the body after the frontmatter block.
 */
export function parseFrontmatter(content: string): {meta: Record<string, string | string[]>; body: string} {
	const match = content.match(FM_RE);
	if (!match) return {meta: {}, body: content};
	const meta: Record<string, string | string[]> = {};
	const lines = (match[1] ?? '').split('\n');
	let currentKey = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const idx = line.indexOf(':');
		if (idx > 0 && !line.match(/^\s+-/)) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			// Strip surrounding quotes (single or double)
			if (val.startsWith('"') && val.endsWith('"')) {
				// Double-quoted values are escaped by serializeFmField (`\` -> `\\`, `"` -> `\"`);
				// undo that in a single left-to-right pass so a literal backslash immediately
				// preceding an escaped quote (e.g. `\\\"`) is not mis-paired by a two-step replace.
				val = val.slice(1, -1).replace(/\\(\\|")/g, '$1');
			} else if (val.startsWith("'") && val.endsWith("'")) {
				val = val.slice(1, -1);
			}
			if (key) {
				currentKey = key;
				meta[key] = val;
			}
		} else if (currentKey) {
			// Check for YAML list item (  - value)
			const listMatch = line.match(/^\s+-\s+(.+)/);
			if (listMatch) {
				const prev = meta[currentKey];
				if (Array.isArray(prev)) {
					prev.push(listMatch[1]!.trim());
				} else {
					// Convert from scalar (empty or value) to array
					const arr: string[] = prev && typeof prev === 'string' && prev.length > 0 ? [prev] : [];
					arr.push(listMatch[1]!.trim());
					meta[currentKey] = arr;
				}
			}
		}
	}
	return {meta, body: match[2] ?? ''};
}

/**
 * Lightweight scan for agent configurations in the given vault folder.
 * Reads file names and frontmatter metadata for UI display.
 */
export async function scanAgents(app: App, agentsFolder: string): Promise<AgentConfig[]> {
	const folder = normalizePath(agentsFolder);
	const agents: AgentConfig[] = [];
	const abstract = app.vault.getAbstractFileByPath(folder);
	if (!(abstract instanceof TFolder)) return agents;

	const agentFiles = abstract.children.filter(
		(child): child is TFile => child instanceof TFile && child.extension === 'md'
	);
	const contents = await Promise.all(agentFiles.map(f => app.vault.read(f)));

	for (let i = 0; i < agentFiles.length; i++) {
		const child = agentFiles[i]!;
		const content = contents[i]!;
		const {meta, body} = parseFrontmatter(content);
		const rawTools = meta['tools'];
		const rawSkills = meta['skills'];
		const nameFromFile = child.basename.endsWith('.agent') ? child.basename.replace('.agent', '') : child.basename;
		agents.push({
			name: (typeof meta['name'] === 'string' && meta['name']) ? meta['name'] : nameFromFile,
			description: (typeof meta['description'] === 'string' ? meta['description'] : '') || '',
			model: (typeof meta['model'] === 'string' && meta['model']) || undefined,
			tools: Array.isArray(rawTools) ? rawTools : (typeof rawTools === 'string' && rawTools ? rawTools.split(',').map(t => t.trim()).filter(Boolean) : ('tools' in meta ? [] : undefined)),
			skills: Array.isArray(rawSkills) ? rawSkills : (typeof rawSkills === 'string' && rawSkills ? rawSkills.split(',').map(s => s.trim()).filter(Boolean) : ('skills' in meta ? [] : undefined)),
			instructions: body.trim(),
			filePath: child.path,
		});
	}
	return agents;
}

/**
 * Lightweight scan for skill definitions in the given vault folder.
 * Reads folder names and SKILL.md frontmatter descriptions for UI display.
 */
export async function scanSkills(app: App, skillsFolder: string): Promise<SkillInfo[]> {
	const folder = normalizePath(skillsFolder);
	const skills: SkillInfo[] = [];
	const abstract = app.vault.getAbstractFileByPath(folder);
	if (!(abstract instanceof TFolder)) return skills;

	const skillFolders = abstract.children.filter((child): child is TFolder => child instanceof TFolder);
	const skillFiles = skillFolders.map(child => {
		const f = app.vault.getAbstractFileByPath(normalizePath(`${child.path}/SKILL.md`));
		return f instanceof TFile ? {folder: child, file: f} : null;
	}).filter((x): x is {folder: TFolder; file: TFile} => x !== null);

	const contents = await Promise.all(skillFiles.map(s => app.vault.read(s.file)));

	for (let i = 0; i < skillFiles.length; i++) {
		const {folder: child} = skillFiles[i]!;
		const content = contents[i]!;
		const {meta} = parseFrontmatter(content);
		skills.push({
			name: (typeof meta['name'] === 'string' ? meta['name'] : '') || child.name,
			description: (typeof meta['description'] === 'string' ? meta['description'] : '') || '',
			folderPath: child.path,
		});
	}
	return skills;
}

/** Configuration for writing a skill artifact (SKILL.md inside a named subfolder). */
export interface SkillWriteConfig {
	name: string;
	description: string;
	/** Markdown body for SKILL.md (instructions, examples, etc.). */
	content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an artifact name to a kebab-case filename slug. */
function toKebab(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * Serialize a single frontmatter value.
 * Strings containing colons, quotes, or leading/trailing whitespace are quoted.
 * Double quotes inside values are escaped.
 */
function serializeFmField(key: string, value: string | string[] | boolean): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return `${key}:`;
		const items = value.map(v => `  - ${v}`).join('\n');
		return `${key}:\n${items}`;
	}
	const str = String(value);
	if (str === '') return `${key}:`;
	const needsQuotes = /[:"\n]/.test(str) || str !== str.trim();
	if (needsQuotes) {
		const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		return `${key}: "${escaped}"`;
	}
	return `${key}: ${str}`;
}

/** Build a complete frontmatter + body markdown string. */
function buildMarkdown(fields: [string, string | string[] | boolean | undefined][], body: string): string {
	const fmLines = fields
		.filter((pair): pair is [string, string | string[] | boolean] => pair[1] !== undefined)
		.map(([k, v]) => serializeFmField(k, v));
	const fm = fmLines.length > 0 ? `---\n${fmLines.join('\n')}\n---\n` : '';
	return fm + (body ? `\n${body}\n` : '');
}

// ---------------------------------------------------------------------------
// Folder creation
// ---------------------------------------------------------------------------

/**
 * Ensure a vault folder exists, creating intermediate directories as needed.
 */
export async function ensureFolder(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) return;

	// Walk segments and create missing folders
	const parts = normalized.split('/');
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const abs = app.vault.getAbstractFileByPath(current);
		if (!abs) {
			await app.vault.createFolder(current);
		}
	}
}

// ---------------------------------------------------------------------------
// Write functions
// ---------------------------------------------------------------------------

/**
 * Write a skill as `<skills-folder>/<kebab-name>/SKILL.md`.
 * Creates the skill subdirectory if it does not exist.
 * Returns the vault-relative path of the created SKILL.md.
 */
export async function writeSkill(
	app: App,
	folder: string,
	config: SkillWriteConfig,
): Promise<string> {
	const slug = toKebab(config.name);
	const skillDir = normalizePath(`${folder}/${slug}`);
	await ensureFolder(app, skillDir);
	const filePath = normalizePath(`${skillDir}/SKILL.md`);

	const fields: [string, string | string[] | boolean | undefined][] = [
		['name', config.name],
		['description', config.description],
	];
	const content = buildMarkdown(fields, config.content);
	await lockManager.withLock(filePath, () => app.vault.create(filePath, content));
	return filePath;
}

// ---------------------------------------------------------------------------
// Tool-approval persistence (issue #197)
// ---------------------------------------------------------------------------

/**
 * Persist tool-approval rule string(s) into `_synapse/settings.json`'s `permissions.allow`,
 * creating the file (and `_synapse/`) if absent (AC-3). `ruleStrings` must already be in the
 * CLI's rule-string syntax — callers derive them via `permissionRuleToString()`/
 * `extractAllowRuleStrings()` (`agentService.ts`) so what's shown to the user in
 * `ToolApprovalModal` before persisting is exactly what lands on disk (AC-4).
 *
 * Uses `vault.getAbstractFileByPath` + `vault.read`/`vault.create`/`vault.modify` rather
 * than `node:fs`, parses the existing content as JSON, and writes back every
 * other top-level key untouched: only `permissions.allow` is unioned with `ruleStrings` (never
 * clobbered, never duplicated). `_synapse/settings.json` is read directly by
 * `AgentService.loadVaultSettings()` via `node:fs`, cached by mtime (issue #194): a plain
 * `vault.create`/`vault.modify` write here changes the file's on-disk mtime, so the next query
 * picks up the change with no extra invalidation needed.
 *
 * A malformed existing file is left untouched and reported via a thrown error (surfaced by the
 * caller, e.g. as a `Notice`) rather than silently overwritten — the in-memory conversation grant
 * (`sessionScopePermissions()`) still applies regardless of whether persistence itself succeeds.
 */
export async function persistToolApprovalRules(app: App, ruleStrings: string[]): Promise<void> {
	if (ruleStrings.length === 0) return;
	const path = normalizePath(`${SYNAPSE_FOLDER}/settings.json`);

	await lockManager.withLock(path, async () => {
		await ensureFolder(app, SYNAPSE_FOLDER);

		const existingFile = app.vault.getAbstractFileByPath(path);
		let settings: Record<string, unknown> = {};
		if (existingFile instanceof TFile) {
			const raw = await app.vault.read(existingFile);
			try {
				const parsed: unknown = JSON.parse(raw);
				settings = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
			} catch {
				throw new Error('[synapse] _synapse/settings.json is not valid JSON — fix or remove it, then try "Always allow" again.');
			}
		}

		const existingPermissions = (settings['permissions'] && typeof settings['permissions'] === 'object' && !Array.isArray(settings['permissions']))
			? {...(settings['permissions'] as Record<string, unknown>)}
			: {};
		const existingAllow = Array.isArray(existingPermissions['allow'])
			? (existingPermissions['allow'] as unknown[]).filter((r): r is string => typeof r === 'string')
			: [];
		existingPermissions['allow'] = Array.from(new Set([...existingAllow, ...ruleStrings]));
		settings['permissions'] = existingPermissions;

		const content = `${JSON.stringify(settings, null, 2)}\n`;
		if (existingFile instanceof TFile) {
			await app.vault.modify(existingFile, content);
		} else {
			await app.vault.create(path, content);
		}
	});
}

// ---------------------------------------------------------------------------
// Vault structure scanning
// ---------------------------------------------------------------------------

/**
 * Scan top-level vault folders (name + child count), excluding system and
 * plugin folders.  Does NOT read note contents -- only folder names and counts.
 */
export function scanVaultStructure(
	app: App,
): {name: string; fileCount: number}[] {
	const root = app.vault.getRoot();
	const excluded = new Set([normalizePath(SYNAPSE_FOLDER), app.vault.configDir, '.trash']);

	return root.children
		.filter((child): child is TFolder =>
			child instanceof TFolder &&
			!excluded.has(child.name) &&
			!child.name.startsWith('.'))
		.map(folder => ({
			name: folder.name,
			fileCount: folder.children.length,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// First-run seeding
// ---------------------------------------------------------------------------

/**
 * Install the plugin's starter kit (`STARTER_FILES`, `src/starterKit.ts`) into `_synapse/`.
 * Never overwrites: a file that already exists — including one the user customized — is left
 * alone, so this is safe to re-run. Returns the vault paths it created.
 */
export async function installStarterKit(app: App, synapseFolder = SYNAPSE_FOLDER): Promise<string[]> {
	const created: string[] = [];
	for (const file of STARTER_FILES) {
		const filePath = normalizePath(`${synapseFolder}/${file.path}`);
		if (app.vault.getAbstractFileByPath(filePath)) continue;
		await ensureFolder(app, filePath.slice(0, filePath.lastIndexOf('/')));
		await lockManager.withLock(filePath, () => app.vault.create(filePath, file.content));
		created.push(filePath);
	}
	return created;
}

