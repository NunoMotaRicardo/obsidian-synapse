import {App, normalizePath, TFile, TFolder} from 'obsidian';
import type {AgentConfig, SkillInfo} from './types';
import {SYNAPSE_FOLDER} from './settings';
import {lockManager} from './lockManager';
import {DEFAULT_VAULT_SETTINGS, MANAGED_STARTER_PREFIXES, REPLACEABLE_STARTER_UNITS, STARTER_FILES} from './starterKit';
import {getSynapseSettingsVaultPath, LEGACY_VAULT_SETTINGS_PATH} from './vaultPaths';

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

/** Create `dir` and any missing parents through the raw adapter (the config folder is not in the vault index). */
async function ensureAdapterFolder(app: App, dir: string): Promise<void> {
	const parts = normalizePath(dir).split('/');
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await app.vault.adapter.exists(current))) await app.vault.adapter.mkdir(current);
	}
}

/**
 * Write the settings layer, creating the plugin folder if needed. Raw adapter, because
 * `<configDir>/plugins/...` is not indexed by `Vault`.
 */
async function writeSettingsFile(app: App, path: string, content: string): Promise<void> {
	await ensureAdapterFolder(app, path.slice(0, path.lastIndexOf('/')));
	await app.vault.adapter.write(path, content);
}

/**
 * Persist tool-approval rule string(s) into the per-device settings layer
 * (`<configDir>/plugins/claude-synapse/settings.json`)'s `permissions.allow`, creating the file
 * if absent (AC-3). `ruleStrings` must already be in the CLI's rule-string syntax — callers derive
 * them via `permissionRuleToString()`/`extractAllowRuleStrings()` (`agentService.ts`) so what's
 * shown to the user in `ToolApprovalModal` before persisting is exactly what lands on disk (AC-4).
 *
 * Uses the raw vault adapter (the config folder is outside the vault index), parses the existing
 * content as JSON, and writes back every other top-level key untouched: only `permissions.allow`
 * is unioned with `ruleStrings` (never clobbered, never duplicated). The file is read directly by
 * `AgentService.loadVaultSettings()` via `node:fs`, cached by mtime (issue #194): a write here
 * changes the on-disk mtime, so the next query picks up the change with no extra invalidation.
 *
 * A malformed existing file is left untouched and reported via a thrown error (surfaced by the
 * caller, e.g. as a `Notice`) rather than silently overwritten — the in-memory conversation grant
 * (`sessionScopePermissions()`) still applies regardless of whether persistence itself succeeds.
 */
export async function persistToolApprovalRules(app: App, ruleStrings: string[]): Promise<void> {
	if (ruleStrings.length === 0) return;
	const path = normalizePath(getSynapseSettingsVaultPath(app));

	await lockManager.withLock(path, async () => {
		let settings: Record<string, unknown> = {};
		if (await app.vault.adapter.exists(path)) {
			const raw = await app.vault.adapter.read(path);
			try {
				const parsed: unknown = JSON.parse(raw);
				settings = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
			} catch {
				throw new Error(`[synapse] ${path} is not valid JSON — fix or remove it, then try "Always allow" again.`);
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

		await writeSettingsFile(app, path, `${JSON.stringify(settings, null, 2)}\n`);
	});
}

/**
 * One-time, per-device migration: copy the legacy synced `_synapse/settings.json` into the plugin
 * folder, where the settings layer now lives (per device, hidden from the vault's file explorer).
 * Runs on every startup and is idempotent:
 *
 * - **Copy, never move.** The original is left in place (other devices that have not migrated yet
 *   still need it, and a sync would propagate a delete). It is ignored from now on.
 * - **Never overwrites.** If the plugin folder already has a `settings.json`, nothing happens.
 *
 * Returns `true` when a file was copied.
 */
export async function migrateVaultSettingsToPluginFolder(app: App): Promise<boolean> {
	const dest = normalizePath(getSynapseSettingsVaultPath(app));
	const adapter = app.vault.adapter;
	return lockManager.withLock(dest, async () => {
		if (await adapter.exists(dest)) return false;
		if (!(await adapter.exists(LEGACY_VAULT_SETTINGS_PATH))) return false;
		const content = await adapter.read(LEGACY_VAULT_SETTINGS_PATH);
		await writeSettingsFile(app, dest, content);
		return true;
	});
}

/**
 * Seed the minimal default settings layer (read files, nothing else) into the plugin folder when
 * none exists. Called on first run, after the migration has had its chance to bring an existing
 * `_synapse/settings.json` across. Never overwrites. Returns `true` when written.
 */
export async function seedDefaultVaultSettings(app: App): Promise<boolean> {
	const dest = normalizePath(getSynapseSettingsVaultPath(app));
	return lockManager.withLock(dest, async () => {
		if (await app.vault.adapter.exists(dest)) return false;
		await writeSettingsFile(app, dest, DEFAULT_VAULT_SETTINGS);
		return true;
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

/** A default agent or skill that is already installed: what a replace would overwrite. */
export interface InstalledStarterUnit {
	label: string;
	/** Vault paths of the unit's existing starter files. */
	paths: string[];
}

/** The replaceable starter units (`REPLACEABLE_STARTER_UNITS`) that have at least one file in the vault. */
export function findInstalledStarterUnits(app: App, synapseFolder = SYNAPSE_FOLDER): InstalledStarterUnit[] {
	return REPLACEABLE_STARTER_UNITS
		.map(({label, prefix}) => ({
			label,
			paths: STARTER_FILES
				.filter(file => file.path.startsWith(prefix))
				.map(file => normalizePath(`${synapseFolder}/${file.path}`))
				.filter(filePath => app.vault.getAbstractFileByPath(filePath) instanceof TFile),
		}))
		.filter(unit => unit.paths.length > 0);
}

/**
 * Keep the app-owned starter files (`MANAGED_STARTER_PREFIXES`, currently the `synapse-config`
 * skill) identical to the bundled version. Runs on every startup: a file that differs is rewritten,
 * a missing one is recreated, an identical one is left alone (no write, so no sync churn). Local
 * edits to these files are therefore overwritten — they ship with the plugin. Files in the folder
 * that are not part of the bundle are never touched or deleted. Does nothing when `_synapse/` does
 * not exist (first run is `installStarterKit()`'s job). Returns the vault paths it wrote.
 */
export async function syncManagedStarterFiles(app: App, synapseFolder = SYNAPSE_FOLDER): Promise<string[]> {
	if (!(app.vault.getAbstractFileByPath(synapseFolder) instanceof TFolder)) return [];
	const written: string[] = [];
	for (const file of STARTER_FILES) {
		if (!MANAGED_STARTER_PREFIXES.some(prefix => file.path.startsWith(prefix))) continue;
		const filePath = normalizePath(`${synapseFolder}/${file.path}`);
		const existing = app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			if (await app.vault.read(existing) === file.content) continue;
			await lockManager.withLock(filePath, () => app.vault.modify(existing, file.content));
		} else if (!existing) {
			await ensureFolder(app, filePath.slice(0, filePath.lastIndexOf('/')));
			await lockManager.withLock(filePath, () => app.vault.create(filePath, file.content));
		} else {
			continue;
		}
		written.push(filePath);
	}
	return written;
}

/**
 * Install the plugin's starter kit (`STARTER_FILES`, `src/starterKit.ts`) into `_synapse/`.
 * Existing files — including ones the user customized — are left alone, so this is safe to
 * re-run. The one exception is `replace`: vault paths (from `findInstalledStarterUnits`, each unit
 * confirmed by the caller) to rewrite back to their bundled content. Files not in the starter
 * kit — the user's own agents, skills, and extra files — are never touched. Returns the vault
 * paths it created or replaced.
 */
export async function installStarterKit(
	app: App,
	synapseFolder = SYNAPSE_FOLDER,
	{replace = []}: {replace?: readonly string[]} = {},
): Promise<string[]> {
	const written: string[] = [];
	for (const file of STARTER_FILES) {
		const filePath = normalizePath(`${synapseFolder}/${file.path}`);
		const existing = app.vault.getAbstractFileByPath(filePath);
		if (existing) {
			if (!(replace.includes(filePath) && existing instanceof TFile)) continue;
			await lockManager.withLock(filePath, () => app.vault.modify(existing, file.content));
			written.push(filePath);
			continue;
		}
		await ensureFolder(app, filePath.slice(0, filePath.lastIndexOf('/')));
		await lockManager.withLock(filePath, () => app.vault.create(filePath, file.content));
		written.push(filePath);
	}
	return written;
}

