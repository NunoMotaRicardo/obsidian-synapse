/**
 * Starter kit shipped with the plugin: one agent and four skills that `_synapse/` is seeded with.
 *
 * The files under `src/starter/` mirror their vault paths below `_synapse/` and are bundled into
 * `main.js` as plain text (esbuild `.md` text loader; `vitest.config.ts` mirrors it), so they stay
 * editable as ordinary Markdown in the repo. Installed by `installStarterKit()` in
 * `src/configWriter.ts` — on first run and from Settings → **Capabilities** → **Initialize**.
 */

import writerAgent from './starter/agents/writer.agent.md';
import obsidianSkill from './starter/skills/obsidian/SKILL.md';
import obsidianBases from './starter/skills/obsidian/bases.md';
import obsidianBasesFunctions from './starter/skills/obsidian/bases-functions.md';
import obsidianCli from './starter/skills/obsidian/cli.md';
import obsidianMarkdown from './starter/skills/obsidian/markdown.md';
import synapseConfigSkill from './starter/skills/synapse-config/SKILL.md';
import synapseConfigAgents from './starter/skills/synapse-config/agents.md';
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

export const STARTER_FILES: readonly StarterFile[] = [
	{path: 'agents/writer.agent.md', content: writerAgent},
	{path: 'skills/synapse-config/SKILL.md', content: synapseConfigSkill},
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
