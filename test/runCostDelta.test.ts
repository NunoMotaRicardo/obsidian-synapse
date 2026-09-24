import {describe, it, expect} from 'vitest';
import {computeRunCostDelta} from '../src/agentService';

// ---------------------------------------------------------------------------
// computeRunCostDelta (issue #264 AC-3/AC-4)
//
// CLI >= 2.1.277 reports a resumed/forked session's `total_cost_usd` as the whole
// conversation's cumulative cost rather than the current run's own cost. Since
// `Session.send()` spawns a fresh CLI process per call (seeded with `resume`),
// `assistant.run_result.totalCostUsd` must stay a per-run figure on both old
// (per-run) and new (cumulative) CLIs — see `Session`'s `'result'` case and
// specs/agent-service.md "Run cost reporting".
// ---------------------------------------------------------------------------

describe('computeRunCostDelta', () => {
	it('returns the raw value for the first run of a session (no prior baseline)', () => {
		// Covers both a genuinely new session and the old-CLI per-run behavior on turn 1.
		expect(computeRunCostDelta(0.05, undefined)).toBe(0.05);
	});

	it('returns the delta when the new total is >= the previous cumulative total (new CLI)', () => {
		expect(computeRunCostDelta(0.12, 0.05)).toBeCloseTo(0.07);
	});

	it('returns the raw value when the new total is a fresh per-run figure below the previous total (old CLI)', () => {
		// Old CLI: each result is its own per-run cost, not cumulative — a cheaper
		// second run reports a smaller number than the first run's total.
		expect(computeRunCostDelta(0.02, 0.05)).toBe(0.02);
	});

	it('returns 0 when the cumulative total is unchanged (e.g. a zero-cost run)', () => {
		expect(computeRunCostDelta(0.05, 0.05)).toBe(0);
	});

	it('handles a zero-cost first run', () => {
		expect(computeRunCostDelta(0, undefined)).toBe(0);
	});
});
