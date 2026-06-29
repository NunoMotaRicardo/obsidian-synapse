import {App, normalizePath, TFile, TFolder} from 'obsidian';
import type {AgentConfig, PromptConfig} from './types';
import {parseFrontmatter} from './configLoader';

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
 * Write an agent configuration as `<kebab-name>.agent.md`.
 * Returns the vault-relative path of the created file.
 */
export async function writeAgent(
	app: App,
	folder: string,
	config: Omit<AgentConfig, 'filePath'>,
): Promise<string> {
	await ensureFolder(app, folder);
	const slug = toKebab(config.name);
	const filePath = normalizePath(`${folder}/${slug}.agent.md`);

	const fields: [string, string | string[] | boolean | undefined][] = [
		['name', config.name],
		['description', config.description],
		['model', config.model],
		['tools', config.tools],
		['skills', config.skills],
	];
	const content = buildMarkdown(fields, config.instructions);
	await app.vault.create(filePath, content);
	return filePath;
}

/**
 * Write a prompt configuration as `<kebab-name>.prompt.md`.
 * Returns the vault-relative path of the created file.
 */
export async function writePrompt(
	app: App,
	folder: string,
	config: PromptConfig,
): Promise<string> {
	await ensureFolder(app, folder);
	const slug = toKebab(config.name);
	const filePath = normalizePath(`${folder}/${slug}.prompt.md`);

	const fields: [string, string | string[] | boolean | undefined][] = [
		['agent', config.agent],
		['description', config.description],
	];
	const content = buildMarkdown(fields, config.content);
	await app.vault.create(filePath, content);
	return filePath;
}

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
	await app.vault.create(filePath, content);
	return filePath;
}

// ---------------------------------------------------------------------------
// Modify / Delete
// ---------------------------------------------------------------------------

/**
 * Modify an existing artifact file by patching frontmatter fields and/or body.
 * Only the keys present in `updates` are changed; others are preserved.
 * Pass `body` in updates to replace the markdown body.
 */
export async function modifyArtifact(
	app: App,
	filePath: string,
	updates: Record<string, string | string[] | boolean | undefined> & {body?: string},
): Promise<void> {
	const normalized = normalizePath(filePath);
	const file = app.vault.getAbstractFileByPath(normalized);
	if (!(file instanceof TFile)) {
		throw new Error(`Artifact not found: ${normalized}`);
	}

	const raw = await app.vault.read(file);
	const {meta, body} = parseFrontmatter(raw);

	// Merge frontmatter updates
	const merged: Record<string, string | string[] | boolean> = {};
	for (const [k, v] of Object.entries(meta)) {
		merged[k] = v;
	}
	for (const [k, v] of Object.entries(updates)) {
		if (k === 'body') continue;
		if (v === undefined) {
			delete merged[k];
		} else {
			merged[k] = v;
		}
	}

	const newBody = updates.body !== undefined ? updates.body : body.trim();
	const fields: [string, string | string[] | boolean][] = Object.entries(merged);
	const content = buildMarkdown(
		fields.map(([k, v]) => [k, v] as [string, string | string[] | boolean | undefined]),
		newBody,
	);
	await app.vault.modify(file, content);
}

/**
 * Delete an artifact file using Obsidian-safe trash.
 */
export async function deleteArtifact(app: App, filePath: string): Promise<void> {
	const normalized = normalizePath(filePath);
	const file = app.vault.getAbstractFileByPath(normalized);
	if (!(file instanceof TFile)) {
		throw new Error(`Artifact not found: ${normalized}`);
	}
	await app.vault.trash(file, false);
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
	synapseFolder: string,
): {name: string; fileCount: number}[] {
	const root = app.vault.getRoot();
	const normalized = normalizePath(synapseFolder);
	const excluded = new Set([normalized, '.obsidian', '.trash']);

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
