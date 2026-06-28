import {App, normalizePath, TFile} from 'obsidian';
import type {AgentConfig, PromptConfig, TriggerConfig} from './types';

/** Configuration for writing a skill artifact. */
export interface SkillWriteConfig {
	name: string;
	description: string;
	body: string;
}

/**
 * Convert a name to a kebab-case filename slug.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims hyphens.
 */
export function toKebabCase(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Serialize a key-value pair as frontmatter-compatible line(s).
 * Scalars: `key: value`; arrays: one `    - item` line per element.
 * Strings containing colons are quoted.
 */
function serializeFmField(key: string, value: string | string[] | boolean | undefined): string {
	if (value === undefined) return '';
	if (typeof value === 'boolean') return `${key}: ${value}`;
	if (Array.isArray(value)) {
		if (value.length === 0) return `${key}:`;
		return `${key}:\n` + value.map(v => `    - ${v}`).join('\n');
	}
	// Scalar string — quote if it contains a colon
	const quoted = value.includes(':') ? `"${value}"` : value;
	return `${key}: ${quoted}`;
}

/**
 * Build a complete frontmatter + body markdown string.
 */
function buildMarkdown(fields: Array<[string, string | string[] | boolean | undefined]>, body: string): string {
	const fmLines = fields
		.map(([k, v]) => serializeFmField(k, v))
		.filter(line => line.length > 0);
	const fm = fmLines.length > 0 ? `---\n${fmLines.join('\n')}\n---\n` : '';
	return fm + (body ? `\n${body}\n` : '');
}

/**
 * Ensure all intermediate folders exist for the given vault path.
 */
export async function ensureFolder(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	const parts = normalized.split('/');
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}

/**
 * Write an agent artifact (*.agent.md) into the agents folder.
 */
export async function writeAgent(
	app: App,
	folder: string,
	config: Omit<AgentConfig, 'filePath'>,
): Promise<string> {
	const slug = toKebabCase(config.name);
	const fileName = `${slug}.agent.md`;
	const filePath = normalizePath(`${folder}/${fileName}`);

	const fields: Array<[string, string | string[] | boolean | undefined]> = [
		['name', config.name],
		['description', config.description],
	];
	if (config.model) fields.push(['model', config.model]);
	if (config.tools !== undefined) fields.push(['tools', config.tools]);
	if (config.skills !== undefined) fields.push(['skills', config.skills]);

	const content = buildMarkdown(fields, config.instructions);
	await ensureFolder(app, folder);
	await app.vault.create(filePath, content);
	return filePath;
}

/**
 * Write a prompt artifact (*.prompt.md) into the prompts folder.
 */
export async function writePrompt(
	app: App,
	folder: string,
	config: Omit<PromptConfig, 'name'> & {name: string},
): Promise<string> {
	const slug = toKebabCase(config.name);
	const fileName = `${slug}.prompt.md`;
	const filePath = normalizePath(`${folder}/${fileName}`);

	const fields: Array<[string, string | string[] | boolean | undefined]> = [];
	if (config.agent) fields.push(['agent', config.agent]);
	if (config.description) fields.push(['description', config.description]);

	const content = buildMarkdown(fields, config.content);
	await ensureFolder(app, folder);
	await app.vault.create(filePath, content);
	return filePath;
}

/**
 * Write a skill artifact (<name>/SKILL.md) inside the skills folder.
 * Creates the subdirectory if needed.
 */
export async function writeSkill(
	app: App,
	folder: string,
	config: SkillWriteConfig,
): Promise<string> {
	const slug = toKebabCase(config.name);
	const skillDir = normalizePath(`${folder}/${slug}`);
	const filePath = normalizePath(`${skillDir}/SKILL.md`);

	const fields: Array<[string, string | string[] | boolean | undefined]> = [
		['name', config.name],
		['description', config.description],
	];

	const content = buildMarkdown(fields, config.body);
	await ensureFolder(app, skillDir);
	await app.vault.create(filePath, content);
	return filePath;
}

/**
 * Write a trigger artifact (*.trigger.md) into the triggers folder.
 */
export async function writeTrigger(
	app: App,
	folder: string,
	config: Omit<TriggerConfig, 'filePath'>,
): Promise<string> {
	const slug = toKebabCase(config.name);
	const fileName = `${slug}.trigger.md`;
	const filePath = normalizePath(`${folder}/${fileName}`);

	const fields: Array<[string, string | string[] | boolean | undefined]> = [
		['name', config.name],
	];
	if (config.description) fields.push(['description', config.description]);
	if (config.agent) fields.push(['agent', config.agent]);
	if (config.cron) fields.push(['cron', config.cron]);
	if (config.glob) fields.push(['glob', config.glob]);
	fields.push(['enabled', config.enabled]);

	const content = buildMarkdown(fields, config.content);
	await ensureFolder(app, folder);
	await app.vault.create(filePath, content);
	return filePath;
}

/**
 * Modify an existing artifact file by patching frontmatter fields and/or body.
 * Only provided keys are updated; omitted keys are preserved.
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
	const fmRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
	const match = raw.match(fmRe);

	const existingFields: Array<[string, string | string[] | boolean]> = [];
	let existingBody = raw;

	if (match) {
		existingBody = match[2] ?? '';
		// Parse existing frontmatter preserving order
		const lines = (match[1] ?? '').split('\n');
		let currentKey = '';
		for (const line of lines) {
			const idx = line.indexOf(':');
			if (idx > 0 && !line.match(/^\s+-/)) {
				const key = line.slice(0, idx).trim();
				let val = line.slice(idx + 1).trim();
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				if (key) {
					currentKey = key;
					existingFields.push([key, val]);
				}
			} else if (currentKey) {
				const listMatch = line.match(/^\s+-\s+(.+)/);
				if (listMatch) {
					const last = existingFields[existingFields.length - 1];
					if (last && last[0] === currentKey) {
						const prev = last[1];
						if (Array.isArray(prev)) {
							prev.push(listMatch[1]!.trim());
						} else {
							last[1] = prev && typeof prev === 'string' && prev.length > 0
								? [prev, listMatch[1]!.trim()]
								: [listMatch[1]!.trim()];
						}
					}
				}
			}
		}
	}

	// Apply updates to fields
	const {body: newBody, ...fieldUpdates} = updates;
	for (const [key, value] of Object.entries(fieldUpdates)) {
		if (value === undefined) continue;
		const idx = existingFields.findIndex(([k]) => k === key);
		if (idx >= 0) {
			existingFields[idx] = [key, value as string | string[] | boolean];
		} else {
			existingFields.push([key, value as string | string[] | boolean]);
		}
	}

	const body = newBody !== undefined ? newBody : existingBody;
	const content = buildMarkdown(
		existingFields.map(([k, v]) => [k, v] as [string, string | string[] | boolean | undefined]),
		typeof body === 'string' ? body.trim() : '',
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
