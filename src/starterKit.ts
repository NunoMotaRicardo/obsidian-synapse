/**
 * Starter kit shipped with the plugin: two agents and four skills that `_synapse/` is seeded with.
 *
 * The files under `src/starter/` mirror their vault paths below `_synapse/` and are bundled into
 * `main.js` as plain text (esbuild `.md` text loader; `vitest.config.ts` mirrors it), so they stay
 * editable as ordinary Markdown in the repo. Installed by `installStarterKit()` in
 * `src/configWriter.ts` — on first run and from Settings → **Capabilities** → **Initialize**.
 */

import searchAgent from './starter/agents/search.agent.md';
import writerAgent from './starter/agents/writer.agent.md';
import obsidianSkill from './starter/skills/obsidian/SKILL.md';
import obsidianBases from './starter/skills/obsidian/bases.md';
import obsidianBasesFunctions from './starter/skills/obsidian/bases-functions.md';
import obsidianCli from './starter/skills/obsidian/cli.md';
import obsidianMarkdown from './starter/skills/obsidian/markdown.md';
import synapseConfigSkill from './starter/skills/synapse-config/SKILL.md';
import synapseConfigAgents from './starter/skills/synapse-config/agents.md';
import synapseConfigSettings from './starter/skills/synapse-config/settings.md';
import synapseConfigSetup from './starter/skills/synapse-config/setup.md';
import synapseConfigSkills from './starter/skills/synapse-config/skills.md';
import thinkSkill from './starter/skills/think/SKILL.md';
import writingStyleSkill from './starter/skills/writing-style/SKILL.md';

/** A starter file: `path` is relative to the `_synapse/` folder. */
export interface StarterFile {
	path: string;
	content: string;
}

/** Name of the skill that sets up and customizes Synapse (the self-improve target). */
export const SYNAPSE_CONFIG_SKILL_NAME = 'synapse-config';

/** Name of the starter agent that carries the vault-search instructions (`agents/search.agent.md`). */
export const SEARCH_AGENT_NAME = 'Search';

/** The Search agent's instructions (file body without frontmatter) — the fallback when the agent isn't installed. */
export const SEARCH_AGENT_INSTRUCTIONS = searchAgent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

/**
 * Default `_synapse/settings.json`: the minimal permission set — read files, nothing else. A bare
 * `Read` rule is used because a path-scoped `Read(./**)` did not match in practice. Everything broader is granted by the user via **Always allow** or the synapse-config skill.
 */
const DEFAULT_VAULT_SETTINGS = `${JSON.stringify({permissions: {allow: ['Read']}}, null, 2)}\n`;

export const STARTER_FILES: readonly StarterFile[] = [
	{path: 'settings.json', content: DEFAULT_VAULT_SETTINGS},
	{path: 'agents/writer.agent.md', content: writerAgent},
	{path: 'agents/search.agent.md', content: searchAgent},
	{path: 'skills/synapse-config/SKILL.md', content: synapseConfigSkill},
	{path: 'skills/synapse-config/settings.md', content: synapseConfigSettings},
	{path: 'skills/synapse-config/agents.md', content: synapseConfigAgents},
	{path: 'skills/synapse-config/skills.md', content: synapseConfigSkills},
	{path: 'skills/synapse-config/setup.md', content: synapseConfigSetup},
	{path: 'skills/obsidian/SKILL.md', content: obsidianSkill},
	{path: 'skills/obsidian/markdown.md', content: obsidianMarkdown},
	{path: 'skills/obsidian/bases.md', content: obsidianBases},
	{path: 'skills/obsidian/bases-functions.md', content: obsidianBasesFunctions},
	{path: 'skills/obsidian/cli.md', content: obsidianCli},
	{path: 'skills/think/SKILL.md', content: thinkSkill},
	{path: 'skills/writing-style/SKILL.md', content: writingStyleSkill},
];

/**
 * Starter files the user may reset to their bundled version (Settings → **Initialize**), grouped
 * so each agent or skill is confirmed as one unit. `think` and `writing-style` are deliberately
 * absent — they hold the user's own voice and styles and are only ever created when missing.
 */
export const REPLACEABLE_STARTER_UNITS: readonly {label: string; prefix: string}[] = [
	{label: 'Writer agent', prefix: 'agents/writer.agent.md'},
	{label: 'Search agent', prefix: 'agents/search.agent.md'},
	{label: 'obsidian skill', prefix: 'skills/obsidian/'},
	{label: 'synapse-config skill', prefix: 'skills/synapse-config/'},
];
