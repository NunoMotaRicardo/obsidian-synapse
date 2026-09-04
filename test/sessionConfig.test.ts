import {describe, it, expect, vi, beforeEach} from 'vitest';
import type {App, TFile} from 'obsidian';

// Mock configWriter so scanVaultStructure can be controlled per test
vi.mock('../src/configWriter', () => ({
	scanVaultStructure: vi.fn(),
}));

import {buildSelfImproveHint, buildVaultContextBlock, resolveModelForAgent, mapSlashCommandsToSkillInfo, mapAgentInfoToAgentConfig} from '../src/view/sessionConfig';
import {scanVaultStructure} from '../src/configWriter';
import type {ModelInfo, SlashCommand, AgentInfo} from '../src/agentService';
import type {AgentConfig} from '../src/types';

const mockedScanVaultStructure = scanVaultStructure as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// buildSelfImproveHint
// ---------------------------------------------------------------------------

describe('buildSelfImproveHint', () => {
	it('contains the agent name', () => {
		const result = buildSelfImproveHint('TestAgent');
		expect(result).toContain('TestAgent');
	});

	it('references the _synapse/ folder', () => {
		const result = buildSelfImproveHint('TestAgent');
		expect(result).toContain('_synapse/');
	});

	it('contains "Self-Improve" heading marker', () => {
		const result = buildSelfImproveHint('TestAgent');
		expect(result).toContain('Self-Improve');
	});

	it('returns a non-empty string for any agent name', () => {
		expect(buildSelfImproveHint('').length).toBeGreaterThan(0);
		expect(buildSelfImproveHint('   ').length).toBeGreaterThan(0);
	});

	it('different agent names produce different outputs', () => {
		const a = buildSelfImproveHint('AgentAlpha');
		const b = buildSelfImproveHint('AgentBeta');
		expect(a).not.toBe(b);
		expect(a).toContain('AgentAlpha');
		expect(b).toContain('AgentBeta');
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

	it('includes item counts in the output', () => {
		mockedScanVaultStructure.mockReturnValue([
			{name: 'notes', fileCount: 7},
		]);

		const result = buildVaultContextBlock(mockApp);

		expect(result).toContain('7');
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
