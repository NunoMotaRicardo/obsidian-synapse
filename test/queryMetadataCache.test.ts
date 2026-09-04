import {describe, it, expect, vi} from 'vitest';
import {refreshQueryMetadataCache, type QueryMetadataCache} from '../src/agentService';
import type {Query, SDKControlGetContextUsageResponse, SlashCommand, AgentInfo} from '../src/agentService';

// ---------------------------------------------------------------------------
// refreshQueryMetadataCache (issue #130) — capture-and-cache, not a persistent
// query. See .docs/decisions/2026-09-04-persistent-query-cache.md for the full
// decision and the empirical timing finding this function encodes: control
// requests on a single-turn `query()`'s `Query` handle only succeed before the
// terminal `result` message is delivered, never at or after it. Session.send()
// calls this once per non-partial 'assistant' SDKMessage, each call
// overwriting the previous — this test file exercises the pure cache-update
// function directly, independent of any live CLI.
// ---------------------------------------------------------------------------

function makeUsage(percentage: number): SDKControlGetContextUsageResponse {
	return {
		categories: [],
		totalTokens: Math.round(percentage * 2000),
		maxTokens: 200000,
		rawMaxTokens: 200000,
		percentage,
		gridRows: [],
		model: 'claude-sonnet-5',
		memoryFiles: [],
		mcpTools: [],
	} as unknown as SDKControlGetContextUsageResponse;
}

const commands: SlashCommand[] = [{name: 'usage', description: 'Show usage', argumentHint: ''}];
const agents: AgentInfo[] = [{name: 'Explore', description: 'Read-only exploration'}];

function mockQuery(overrides?: Partial<Pick<Query, 'getContextUsage' | 'supportedCommands' | 'supportedAgents'>>) {
	return {
		getContextUsage: vi.fn().mockResolvedValue(makeUsage(42)),
		supportedCommands: vi.fn().mockResolvedValue(commands),
		supportedAgents: vi.fn().mockResolvedValue(agents),
		...overrides,
	} as unknown as Pick<Query, 'getContextUsage' | 'supportedCommands' | 'supportedAgents'>;
}

describe('refreshQueryMetadataCache', () => {
	it('captures all three fields on success', async () => {
		const result = await refreshQueryMetadataCache(mockQuery(), {});
		expect(result.contextUsage?.percentage).toBe(42);
		expect(result.commands).toEqual(commands);
		expect(result.agents).toEqual(agents);
	});

	it('overwrites a previous cache entirely on a fresh success (not merged)', async () => {
		const prev: QueryMetadataCache = {
			contextUsage: makeUsage(10),
			commands: [{name: 'old', description: '', argumentHint: ''}],
			agents: [{name: 'OldAgent', description: ''}],
		};
		const result = await refreshQueryMetadataCache(mockQuery(), prev);
		expect(result.contextUsage?.percentage).toBe(42);
		expect(result.commands).toEqual(commands);
		expect(result.agents).toEqual(agents);
	});

	it('leaves the previous cache entirely unchanged when getContextUsage rejects', async () => {
		const prev: QueryMetadataCache = {
			contextUsage: makeUsage(10),
			commands: [{name: 'old', description: '', argumentHint: ''}],
			agents: [{name: 'OldAgent', description: ''}],
		};
		const failing = mockQuery({
			getContextUsage: vi.fn().mockRejectedValue(new Error('Query closed before response received')),
		});
		const result = await refreshQueryMetadataCache(failing, prev);
		expect(result).toBe(prev);
		expect(result.contextUsage?.percentage).toBe(10);
	});

	it('leaves the previous cache unchanged when any one of the three calls rejects (Promise.all fails fast)', async () => {
		const prev: QueryMetadataCache = {contextUsage: makeUsage(5)};
		const failing = mockQuery({
			supportedAgents: vi.fn().mockRejectedValue(new Error('older CLI, no control-protocol support')),
		});
		const result = await refreshQueryMetadataCache(failing, prev);
		expect(result).toBe(prev);
	});

	it('never throws — a rejected control request resolves to the previous cache', async () => {
		const failing = mockQuery({
			getContextUsage: vi.fn().mockRejectedValue(new Error('boom')),
			supportedCommands: vi.fn().mockRejectedValue(new Error('boom')),
			supportedAgents: vi.fn().mockRejectedValue(new Error('boom')),
		});
		await expect(refreshQueryMetadataCache(failing, {})).resolves.toEqual({});
	});

	it('reports the failure via the optional debug callback without throwing', async () => {
		const onDebug = vi.fn();
		const failing = mockQuery({
			getContextUsage: vi.fn().mockRejectedValue(new Error('Query closed before response received')),
		});
		await refreshQueryMetadataCache(failing, {}, onDebug);
		expect(onDebug).toHaveBeenCalledTimes(1);
		expect(onDebug.mock.calls[0]![0]).toContain('Query closed before response received');
	});

	it('starting from an empty cache and failing leaves it empty (no capture ever happened)', async () => {
		const failing = mockQuery({
			getContextUsage: vi.fn().mockRejectedValue(new Error('boom')),
		});
		const result = await refreshQueryMetadataCache(failing, {});
		expect(result).toEqual({});
		expect(result.contextUsage).toBeUndefined();
	});
});
