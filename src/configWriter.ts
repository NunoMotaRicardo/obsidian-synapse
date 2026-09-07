import {App, normalizePath, TFile, TFolder} from 'obsidian';
import type {AgentConfig, SkillInfo} from './types';
import {SYNAPSE_FOLDER} from './settings';
import {lockManager} from './lockManager';

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
 * Write an agent configuration as `<kebab-name>.md`.
 * Returns the vault-relative path of the created file.
 */
export async function writeAgent(
	app: App,
	folder: string,
	config: Omit<AgentConfig, 'filePath'>,
): Promise<string> {
	await ensureFolder(app, folder);
	const slug = toKebab(config.name);
	const filePath = normalizePath(`${folder}/${slug}.md`);

	const fields: [string, string | string[] | boolean | undefined][] = [
		['description', config.description],
		['model', config.model],
		['tools', config.tools],
		['skills', config.skills],
	];
	const content = buildMarkdown(fields, config.instructions);
	await lockManager.withLock(filePath, () => app.vault.create(filePath, content));
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
	await lockManager.withLock(filePath, () => app.vault.create(filePath, content));
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

	await lockManager.withLock(normalized, async () => {
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
	});
}

/**
 * Delete an artifact file using Obsidian-safe trash.
 */
export async function deleteArtifact(app: App, filePath: string): Promise<void> {
	const normalized = normalizePath(filePath);
	await lockManager.withLock(normalized, async () => {
		const file = app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) {
			throw new Error(`Artifact not found: ${normalized}`);
		}
		await app.vault.trash(file, false);
	});
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
 * Uses `vault.adapter.exists` + `vault.read`/`vault.create`/`vault.modify` — the same pattern
 * `appendReportBlock()` (`runExecutor.ts`) uses for a vault-relative file that may or may not
 * exist yet — rather than `node:fs`, parses the existing content as JSON, and writes back every
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

		const exists = await app.vault.adapter.exists(path);
		const existingFile = exists ? app.vault.getAbstractFileByPath(path) : null;
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

export const IMPROVE_SYNAPSE_SKILL_NAME = 'improve-synapse';
export const IMPROVE_SYNAPSE_SKILL_DESC = 'Comprehensive reference and guide for creating and modifying Synapse vault-local customization artifacts (agents and skills) in _synapse/';

export const IMPROVE_SYNAPSE_SKILL_BODY = `# Improve Synapse Skill

Use this skill when the user asks to create, modify, or manage Synapse customization artifacts (agents and skills) in your Obsidian vault.

## Vault Folder Structure

\`\`\`
_synapse/
  agents/*.md
  skills/<name>/SKILL.md
  .mcp.json
\`\`\`

## Naming Conventions

- Filenames use **kebab-case** derived from the artifact name.
  - Example: "Academic Research" becomes \`academic-research.md\` inside \`_synapse/agents/\`.
- Skills live in a subfolder named after the skill: \`_synapse/skills/<kebab-name>/SKILL.md\`.

## Permission Model

- **Always ask the user for permission** before creating or modifying any artifact file.
- State clearly what file you plan to create or modify, including its target path and a summary of contents.
- For **deletion**, ask for explicit extra confirmation.

## Artifact Types & Specifications

### 1. Agents
File location: \`_synapse/agents/<kebab-name>.md\`

Frontmatter fields:
- \`description\` (required) — short purpose summary shown in UI dropdowns
- \`model\` (optional) — model ID or reference
- \`tools\` (optional) — list of allowed tools (omit for all, empty list \`[]\` for none)
- \`skills\` (optional) — list of allowed skill names (omit for all, empty list \`[]\` for none)

Body: System instructions defining the agent's persona and behavior.

Example:
\`\`\`markdown
---
description: Specialty agent for academic citation and research drafting.
tools:
  - Read
  - Write
---

# Academic Research Agent

You are an expert academic research assistant. Always format citations in APA style and maintain an objective tone.
\`\`\`

### 2. Skills
File location: \`_synapse/skills/<kebab-name>/SKILL.md\`

Frontmatter fields:
- \`name\` (required) — skill identifier (used for slash commands like \`/improve-synapse\`)
- \`description\` (required) — short description of what this skill teaches the agent

Body: Detailed procedures, reference material, workflows, or prompt instructions.

Example:
\`\`\`markdown
---
name: apa-citations
description: Teaches the agent to format references according to APA 7th edition guidelines.
---

# APA Citation Formatting Skill

When this skill is active or invoked, format all references and in-text citations following APA 7th edition standard rules.
\`\`\`

### 3. MCP Servers Configuration
File location: \`_synapse/.mcp.json\`

Contains standard Model Context Protocol (MCP) server configurations.

---

## Workflow for Assisting the User

1. **Understand Intent**: Clarify the desired behavior, persona, or capability the user wants to add or adjust.
2. **Select Artifact Type**:
   - Create an **Agent** if defining a full persistent persona with specific instruction sets or tool restrictions.
   - Create a **Skill** if adding specific procedures, domain knowledge, workflows, or slash commands.
3. **Propose Changes**: Show the proposed frontmatter and content to the user.
4. **Write Artifact**: Once approved, write the file to the corresponding location under \`_synapse/\`.
`;

/**
 * Ensure the default `improve-synapse` skill exists in `_synapse/skills/improve-synapse/SKILL.md`.
 * If missing, seeds it using `writeSkill`.
 */
export async function ensureImproveSynapseSkill(app: App, synapseFolder = SYNAPSE_FOLDER): Promise<string | null> {
	const skillPath = normalizePath(`${synapseFolder}/skills/${IMPROVE_SYNAPSE_SKILL_NAME}/SKILL.md`);
	if (app.vault.getAbstractFileByPath(skillPath)) {
		return null;
	}
	return await writeSkill(app, `${synapseFolder}/skills`, {
		name: IMPROVE_SYNAPSE_SKILL_NAME,
		description: IMPROVE_SYNAPSE_SKILL_DESC,
		content: IMPROVE_SYNAPSE_SKILL_BODY,
	});
}

