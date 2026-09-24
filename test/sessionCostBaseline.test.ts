import {describe, it, expect} from 'vitest';
import {upsertSessionCostBaseline} from '../src/agentService';

// ---------------------------------------------------------------------------
// upsertSessionCostBaseline (issue #269 AC-1)
//
// Persists the last-seen cumulative `total_cost_usd` per SDK session id
// (SynapseSettings.sessionCostBaselines) so a cold resume of an old
// conversation from the sidebar can seed AgentService.createSession()'s
// initialCumulativeCostUsd instead of starting with no baseline at all.
// ---------------------------------------------------------------------------

describe('upsertSessionCostBaseline', () => {
	it('adds a new entry to an undefined map', () => {
		const result = upsertSessionCostBaseline(undefined, 'session-a', 0.5);
		expect(result).toEqual({'session-a': 0.5});
	});

	it('does not mutate the input map', () => {
		const input = {'session-a': 0.5};
		const result = upsertSessionCostBaseline(input, 'session-b', 1.2);
		expect(input).toEqual({'session-a': 0.5});
		expect(result).toEqual({'session-a': 0.5, 'session-b': 1.2});
	});

	it('overwrites an existing entry for the same session id', () => {
		const input = {'session-a': 0.5};
		const result = upsertSessionCostBaseline(input, 'session-a', 0.9);
		expect(result).toEqual({'session-a': 0.9});
	});

	it('evicts the least-recently-touched entries once maxEntries is exceeded', () => {
		let baselines: Record<string, number> | undefined = undefined;
		baselines = upsertSessionCostBaseline(baselines, 'a', 0.1, 3);
		baselines = upsertSessionCostBaseline(baselines, 'b', 0.2, 3);
		baselines = upsertSessionCostBaseline(baselines, 'c', 0.3, 3);
		// Adding a 4th entry should evict 'a' (the oldest-touched).
		baselines = upsertSessionCostBaseline(baselines, 'd', 0.4, 3);
		expect(baselines).toEqual({b: 0.2, c: 0.3, d: 0.4});
	});

	it('re-touching an existing entry moves it to the back of the eviction order', () => {
		let baselines: Record<string, number> | undefined = undefined;
		baselines = upsertSessionCostBaseline(baselines, 'a', 0.1, 2);
		baselines = upsertSessionCostBaseline(baselines, 'b', 0.2, 2);
		// Re-touch 'a' — it should no longer be the oldest entry.
		baselines = upsertSessionCostBaseline(baselines, 'a', 0.15, 2);
		// Adding a new entry should now evict 'b', not 'a'.
		baselines = upsertSessionCostBaseline(baselines, 'c', 0.3, 2);
		expect(baselines).toEqual({a: 0.15, c: 0.3});
	});

	it('defaults to the module cap when maxEntries is omitted', () => {
		let baselines: Record<string, number> = {};
		for (let i = 0; i < 60; i++) {
			baselines = upsertSessionCostBaseline(baselines, `session-${i}`, i);
		}
		expect(Object.keys(baselines).length).toBe(50);
		// The most recently added entry always survives.
		expect(baselines['session-59']).toBe(59);
		// The oldest entries were evicted.
		expect(baselines['session-0']).toBeUndefined();
	});
});
