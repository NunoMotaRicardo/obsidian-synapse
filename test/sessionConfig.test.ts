import {describe, it, expect, vi, beforeEach} from 'vitest';
import type {App, TFile} from 'obsidian';

// Mock configWriter so scanVaultStructure can be controlled per test
vi.mock('../src/configWriter', () => ({
	scanVaultStructure: vi.fn(),
}));

import {buildSelfImproveHint, buildCurrentAgentLine, buildTurnContextBlock, buildVaultContextBlock, resolveModelForAgent, mapSlashCommandsToSkillInfo, mapAgentInfoToAgentConfig, mergeLiveAgents, mergeLiveSkills, splitCommandNamespace} from '../src/view/sessionConfig';
import {scanVaultStructure} from '../src/configWriter';
import type {ModelInfo, SlashCommand, AgentInfo} from '../src/agentService';
import type {AgentConfig, SkillInfo} from '../src/types';

const mockedScanVaultStructure = scanVaultStructure as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// buildSelfImproveHint
// ---------------------------------------------------------------------------

describe('buildSelfImproveHint', () => {
	// Session-stable (issue #201) — no longer takes an agent name; that volatile piece is
	// now `buildCurrentAgentLine()`, delivered per-turn instead of baked into this hint.
	it('references the _synapse/ folder', () => {
		const result = buildSelfImproveHint();
		expect(result).toContain('_synapse/');
	});

	it('contains "Self-Improve" heading marker', () => {
		const result = buildSelfImproveHint();
		expect(result).toContain('Self-Improve');
	});

	it('returns a non-empty string', () => {
		expect(buildSelfImproveHint().length).toBeGreaterThan(0);
	});

	it('is stable across calls (no volatile content)', () => {
		expect(buildSelfImproveHint()).toBe(buildSelfImproveHint());
	});
});

// ---------------------------------------------------------------------------
// buildCurrentAgentLine — the volatile "Current agent" line split out of
// buildSelfImproveHint() (issue #201) so it can be delivered per-turn.
// ---------------------------------------------------------------------------

describe('buildCurrentAgentLine', () => {
	it('contains the agent name', () => {
		expect(buildCurrentAgentLine('TestAgent')).toContain('TestAgent');
	});

	it('different agent names produce different outputs', () => {
		const a = buildCurrentAgentLine('AgentAlpha');
		const b = buildCurrentAgentLine('AgentBeta');
		expect(a).not.toBe(b);
		expect(a).toContain('AgentAlpha');
		expect(b).toContain('AgentBeta');
	});

	it('mentions "Current agent"', () => {
		expect(buildCurrentAgentLine('Auto')).toContain('Current agent');
	});
});

// ---------------------------------------------------------------------------
// buildVaultContextBlock
// ---------------------------------------------------------------------------

describe('buildVaultContextBlock', () => {
	// Minimal App mock — the function delegates to scanVaultStructure which is mocked
	const mockApp = {
		vault: {
			getFiles: () => [] as TFile[],
		},
	} as unknown as App;

	beforeEach(() => {
		mockedScanVaultStructure.mockReset();
	});

	it('returns empty string when scanVaultStructure returns no folders', () => {
		mockedScanVaultStructure.mockReturnValue([]);

		const result = buildVaultContextBlock(mockApp);

		expect(result).toBe('');
	});

	it('returns a non-empty string when folders exist', () => {
		mockedScanVaultStructure.mockReturnValue([
			{name: 'inbox', fileCount: 3},
			{name: 'projects', fileCount: 12},
		]);

		const result = buildVaultContextBlock(mockApp);

		expect(result).not.toBe('');
	});

	it('includes folder names in the output', () => {
		mockedScanVaultStructure.mockReturnValue([
			{name: 'inbox', fileCount: 3},
			{name: 'projects', fileCount: 12},
		]);

		const result = buildVaultContextBlock(mockApp);

		expect(result).toContain('inbox');
		expect(result).toContain('projects');
	});

	it('does not include item counts in the output (issue #201)', () => {
		mockedScanVaultStructure.mockReturnValue([
			{name: 'notes', fileCount: 7},
		]);

		const result = buildVaultContextBlock(mockApp);

		expect(result).not.toContain('7');
		expect(result).not.toContain('items');
		expect(result).not.toContain('(');
	});

	it('contains [Vault Structure] label', () => {
		mockedScanVaultStructure.mockReturnValue([
			{name: 'notes', fileCount: 1},
		]);

		const result = buildVaultContextBlock(mockApp);

		expect(result).toContain('[Vault Structure]');
	});

	it('passes the app to scanVaultStructure', () => {
		mockedScanVaultStructure.mockReturnValue([]);

		buildVaultContextBlock(mockApp);

		expect(mockedScanVaultStructure).toHaveBeenCalledWith(mockApp);
	});
});

// ---------------------------------------------------------------------------
// buildTurnContextBlock — the per-turn volatile block (Active note, Working
// directory, vault-structure block, current agent) delivered in the user
// message instead of systemPrompt.append (issue #201).
// ---------------------------------------------------------------------------

describe('buildTurnContextBlock', () => {
	const mockApp = {
		vault: {
			getFiles: () => [] as TFile[],
		},
	} as unknown as App;

	beforeEach(() => {
		mockedScanVaultStructure.mockReset();
		mockedScanVaultStructure.mockReturnValue([]);
	});

	it('includes the working directory', () => {
		const result = buildTurnContextBlock({
			app: mockApp,
			vaultRoot: '/vault',
			workingDirectory: '/vault/sub',
		});
		expect(result).toContain('Working directory: /vault/sub');
	});

	it('omits the active note line when no active note is given', () => {
		const result = buildTurnContextBlock({
			app: mockApp,
			vaultRoot: '/vault',
			workingDirectory: '/vault',
		});
		expect(result).not.toContain('Active note');
	});

	it('includes the active note as vaultRoot/activeNotePath when given', () => {
		const result = buildTurnContextBlock({
			app: mockApp,
			vaultRoot: '/vault',
			activeNotePath: 'folder/note.md',
			workingDirectory: '/vault',
		});
		expect(result).toContain('Active note: /vault/folder/note.md');
	});

	it('omits the current agent line when no agent name is given', () => {
		const result = buildTurnContextBlock({
			app: mockApp,
			vaultRoot: '/vault',
			workingDirectory: '/vault',
		});
		expect(result).not.toContain('Current agent');
	});

	it('includes the current agent line when an agent name is given', () => {
		const result = buildTurnContextBlock({
			app: mockApp,
			vaultRoot: '/vault',
			workingDirectory: '/vault',
			agentName: 'TestAgent',
		});
		expect(result).toContain('Current agent: TestAgent.');
	});

	it('includes the count-free vault structure block when folders exist', () => {
		mockedScanVaultStructure.mockReturnValue([{name: 'inbox', fileCount: 3}]);
		const result = buildTurnContextBlock({
			app: mockApp,
			vaultRoot: '/vault',
			workingDirectory: '/vault',
		});
		expect(result).toContain('[Vault Structure]');
		expect(result).toContain('inbox');
		expect(result).not.toContain('3');
	});
});

// ---------------------------------------------------------------------------
// resolveModelForAgent — issue #105. A persisted canonical id (e.g.
// 'claude-sonnet-5') should resolve deterministically to the alias row it
// belongs to via the SDK's `resolvedModel` field, ahead of the existing
// substring/keyword heuristics.
// ---------------------------------------------------------------------------

describe('resolveModelForAgent', () => {
	function makeAgent(model: string | undefined): AgentConfig {
		return {name: 'Test', description: '', model, instructions: '', filePath: 'agents/test.agent.md'};
	}

	const models: ModelInfo[] = [
		{id: 'sonnet', name: 'Sonnet', resolvedModel: 'claude-sonnet-5'},
		{id: 'opus', name: 'Opus', resolvedModel: 'claude-opus-5'},
	];

	it('returns fallback when the agent has no configured model', () => {
		expect(resolveModelForAgent(makeAgent(undefined), models, 'fallback-id')).toBe('fallback-id');
		expect(resolveModelForAgent(undefined, models, 'fallback-id')).toBe('fallback-id');
	});

	it('matches a canonical id against resolvedModel', () => {
		expect(resolveModelForAgent(makeAgent('claude-sonnet-5'), models, undefined)).toBe('sonnet');
	});

	it('matches a canonical id against resolvedModel case-insensitively', () => {
		expect(resolveModelForAgent(makeAgent('CLAUDE-OPUS-5'), models, undefined)).toBe('opus');
	});

	it('still matches by exact id/name when no resolvedModel is set', () => {
		const noResolved: ModelInfo[] = [{id: 'my-model', name: 'My Model'}];
		expect(resolveModelForAgent(makeAgent('My Model'), noResolved, undefined)).toBe('my-model');
	});

	it('falls back to substring/keyword heuristics when nothing matches resolvedModel', () => {
		const noResolved: ModelInfo[] = [{id: 'my-sonnet-mirror', name: 'Sonnet Mirror'}];
		expect(resolveModelForAgent(makeAgent('sonnet'), noResolved, undefined)).toBe('my-sonnet-mirror');
	});

	it('falls back when nothing matches at all', () => {
		expect(resolveModelForAgent(makeAgent('gpt-4o'), models, 'fallback-id')).toBe('fallback-id');
	});
});

// ---------------------------------------------------------------------------
// mapSlashCommandsToSkillInfo / mapAgentInfoToAgentConfig (issue #130) — map
// the CLI's live supportedCommands()/supportedAgents() responses into the
// shapes the slash-command popup (inputArea.ts) and agent picker
// (configToolbar.ts) already render, so those call sites don't need to know
// whether a given entry came from the CLI or the directory scan.
// ---------------------------------------------------------------------------

describe('mapSlashCommandsToSkillInfo', () => {
	it('maps name/description and sets folderPath to the empty string', () => {
		const commands: SlashCommand[] = [
			{name: 'usage', description: 'Show usage', argumentHint: ''},
			{name: 'cost', description: 'Show cost', argumentHint: '', aliases: ['stats']},
		];
		expect(mapSlashCommandsToSkillInfo(commands)).toEqual([
			{name: 'usage', description: 'Show usage', folderPath: ''},
			{name: 'cost', description: 'Show cost', folderPath: ''},
		]);
	});

	it('maps an empty list to an empty list', () => {
		expect(mapSlashCommandsToSkillInfo([])).toEqual([]);
	});
});

describe('mapAgentInfoToAgentConfig', () => {
	it('maps name/description, uses description as instructions, and sets filePath to the empty string', () => {
		const agents: AgentInfo[] = [{name: 'Explore', description: 'Read-only exploration agent'}];
		expect(mapAgentInfoToAgentConfig(agents)).toEqual([
			{name: 'Explore', description: 'Read-only exploration agent', instructions: 'Read-only exploration agent', filePath: ''},
		]);
	});

	it('carries the model field through when present', () => {
		const agents: AgentInfo[] = [{name: 'Fast', description: 'Quick answers', model: 'haiku'}];
		const result = mapAgentInfoToAgentConfig(agents);
		expect(result[0]?.model).toBe('haiku');
	});

	it('omits model when absent rather than setting it to undefined explicitly', () => {
		const agents: AgentInfo[] = [{name: 'Explore', description: 'No model binding'}];
		const result = mapAgentInfoToAgentConfig(agents);
		expect('model' in result[0]!).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// mergeLiveAgents / mergeLiveSkills (issue #130) — the CLI decides which agents
// and skills exist; the vault directory scan supplies the config for those it
// also knows about. Replacing a scanned AgentConfig wholesale would drop its
// declared `tools`/`skills`, and applyAgentToolsAndSkills() reads
// `skills: undefined` as "enable all" — which would silently widen a
// deliberately narrowed agent as soon as the first capture landed.
// ---------------------------------------------------------------------------

describe('mergeLiveAgents', () => {
	const scanned: AgentConfig[] = [
		{
			name: 'Researcher',
			description: 'From the vault',
			instructions: 'Full agent body from the markdown file',
			filePath: '_synapse/agents/researcher.md',
			skills: ['summarize'],
			tools: ['read_note'],
			model: 'sonnet',
		},
	];

	it('preserves a vault agent declared skills and tools instead of widening them', () => {
		const live: AgentInfo[] = [{name: 'Researcher', description: 'From the CLI'}];
		const merged = mergeLiveAgents(live, scanned);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.skills).toEqual(['summarize']);
		expect(merged[0]?.tools).toEqual(['read_note']);
		expect(merged[0]?.instructions).toBe('Full agent body from the markdown file');
		expect(merged[0]?.filePath).toBe('_synapse/agents/researcher.md');
	});

	it('includes CLI-only agents the vault scan never saw', () => {
		const live: AgentInfo[] = [
			{name: 'Researcher', description: 'From the CLI'},
			{name: 'Explore', description: 'Built-in CLI agent'},
		];
		const merged = mergeLiveAgents(live, scanned);
		expect(merged.map(a => a.name)).toEqual(['Researcher', 'Explore']);
		expect(merged[1]?.skills).toBeUndefined();
	});

	it('drops a scanned agent the CLI did not load, since the CLI is authoritative', () => {
		const live: AgentInfo[] = [{name: 'Explore', description: 'Built-in CLI agent'}];
		expect(mergeLiveAgents(live, scanned).map(a => a.name)).toEqual(['Explore']);
	});

	it('returns an empty list when the CLI reports no agents', () => {
		expect(mergeLiveAgents([], scanned)).toEqual([]);
	});
});

describe('mergeLiveSkills', () => {
	const scanned: SkillInfo[] = [
		{name: 'summarize', description: 'From the vault', folderPath: '_synapse/skills/summarize'},
	];

	it('keeps the vault skill folderPath rather than flattening it to the empty string', () => {
		const live: SlashCommand[] = [{name: 'summarize', description: 'From the CLI', argumentHint: ''}];
		const merged = mergeLiveSkills(live, scanned);
		expect(merged[0]?.folderPath).toBe('_synapse/skills/summarize');
	});

	it('includes CLI-only commands with an empty folderPath', () => {
		const live: SlashCommand[] = [
			{name: 'summarize', description: 'From the CLI', argumentHint: ''},
			{name: 'usage', description: 'Built-in', argumentHint: ''},
		];
		const merged = mergeLiveSkills(live, scanned);
		expect(merged.map(s => s.name)).toEqual(['summarize', 'usage']);
		expect(merged[1]?.folderPath).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Command namespacing (issue #163)
//
// The CLI advertises plugin-provided commands as `<plugin>:<command>`, so a vault
// skill `improve-synapse` arrives as `_synapse:improve-synapse`. Carrying that
// through as the skill's `name` made vault skills undiscoverable: the popup filters
// on name, so typing the skill's own name matched nothing, and an agent's
// `skills: [improve-synapse]` restriction stopped matching too. `name` must stay
// unqualified; the namespaced id lives in `qualifiedName` and is what gets inserted.
// ---------------------------------------------------------------------------

describe('splitCommandNamespace', () => {
	it('splits a namespaced command into the plain name plus the full id', () => {
		expect(splitCommandNamespace('_synapse:improve-synapse'))
			.toEqual({name: 'improve-synapse', qualifiedName: '_synapse:improve-synapse'});
	});

	it('leaves an unnamespaced command untouched and sets no qualifiedName', () => {
		expect(splitCommandNamespace('dataviz')).toEqual({name: 'dataviz'});
	});

	it('splits on the last colon so a plugin name containing one still works', () => {
		expect(splitCommandNamespace('a:b:run'))
			.toEqual({name: 'run', qualifiedName: 'a:b:run'});
	});

	it('treats a trailing colon as no namespace rather than yielding an empty name', () => {
		expect(splitCommandNamespace('broken:')).toEqual({name: 'broken:'});
	});
});

describe('mapSlashCommandsToSkillInfo namespacing', () => {
	it('exposes the plain name and keeps the namespaced id separately', () => {
		const mapped = mapSlashCommandsToSkillInfo([
			{name: '_synapse:improve-synapse', description: 'Vault skill', argumentHint: ''},
		]);
		expect(mapped[0]?.name).toBe('improve-synapse');
		expect(mapped[0]?.qualifiedName).toBe('_synapse:improve-synapse');
	});

	it('omits qualifiedName entirely for an unnamespaced command', () => {
		const mapped = mapSlashCommandsToSkillInfo([
			{name: 'dataviz', description: 'Personal skill', argumentHint: ''},
		]);
		expect(mapped[0]?.name).toBe('dataviz');
		expect('qualifiedName' in mapped[0]!).toBe(false);
	});
});

describe('mergeLiveSkills with namespaced commands', () => {
	const scanned: SkillInfo[] = [
		{name: 'improve-synapse', description: 'From the vault', folderPath: '_synapse/skills/improve-synapse'},
	];

	it('matches a namespaced CLI command to the scanned vault skill', () => {
		const merged = mergeLiveSkills(
			[{name: '_synapse:improve-synapse', description: 'From the CLI', argumentHint: ''}],
			scanned,
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.name).toBe('improve-synapse');
		expect(merged[0]?.folderPath).toBe('_synapse/skills/improve-synapse');
	});

	it('carries the CLI qualifiedName onto the scanned entry so insertion still resolves', () => {
		const merged = mergeLiveSkills(
			[{name: '_synapse:improve-synapse', description: 'From the CLI', argumentHint: ''}],
			scanned,
		);
		expect(merged[0]?.qualifiedName).toBe('_synapse:improve-synapse');
	});

	it('lets an agent skills: restriction written as the plain name still match', () => {
		// applyAgentToolsAndSkills() filters with `allowed.has(s.name)`; before #163 the
		// name was '_synapse:improve-synapse', so this restriction silently dropped the skill.
		const merged = mergeLiveSkills(
			[{name: '_synapse:improve-synapse', description: 'From the CLI', argumentHint: ''}],
			scanned,
		);
		const allowed = new Set(['improve-synapse']);
		expect(merged.filter(s => allowed.has(s.name))).toHaveLength(1);
	});
});
